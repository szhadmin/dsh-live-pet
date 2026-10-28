"""抖音网页版直播弹幕直连。

底层用开源项目 **saermart/DouyinLiveWebFetcher**（AGPL-3.0，已 vendor 到
`vendor/douyin_fetcher/`，commit 40a904b / 2026-09-08）：它负责拿 ttwid、算
`signature` / `a_bogus`、连 `wss://webcast*.douyin.com/webcast/im/push/v2/`、
解 protobuf。本文件只做三件事：

1. 把直播间地址解析成 live_id；
2. 把上游的回调（聊天/礼物/点赞/进场/关注）翻译成本项目的事件格式；
3. 断线重连 + 状态回报。
"""
from __future__ import annotations

import json
import random
import re
import sys
import threading
import time
from collections import deque
from pathlib import Path

from . import gifts
from .paths import BASE_DIR, CODE_DIR

ROOT = BASE_DIR
VENDOR = CODE_DIR / "vendor" / "douyin_fetcher"
FRAME_LOG = BASE_DIR / "data" / "douyin-frames.log"

_READY: tuple[bool, str] | None = None
_FETCHER = None
_LIVE_RE = re.compile(r"(?:live\.douyin\.com/)?(\d{6,})")


def available() -> tuple[bool, str]:
    """检查上游代码与依赖是否就绪。"""
    global _READY
    if _READY is not None:
        return _READY
    if not (VENDOR / "liveMan.py").exists():
        _READY = (False, "缺少 vendor/douyin_fetcher，请按教程恢复该目录")
        return _READY
    if str(VENDOR) not in sys.path:
        sys.path.insert(0, str(VENDOR))
    try:
        import requests  # noqa: F401
        import websocket  # noqa: F401
        from py_mini_racer import MiniRacer  # noqa: F401
        import liveMan  # noqa: F401
        from protobuf.douyin import ChatMessage  # noqa: F401
    except Exception as exc:  # pragma: no cover - 环境问题
        _READY = (False, f"依赖缺失：{type(exc).__name__}: {exc}（执行 pip install -r requirements-douyin.txt）")
        return _READY
    _READY = (True, "ok")
    return _READY


def parse_live_id(text: str) -> str:
    """把 `https://live.douyin.com/123456` / `live.douyin.com/123456` / `123456` 统一成 live_id。"""
    text = (text or "").strip()
    if not text:
        return ""
    m = _LIVE_RE.search(text)
    return m.group(1) if m else ""


_SHORT_RE = re.compile(r"(v\.douyin\.com|iesdouyin\.com/share/(?:live|user)|douyin\.com/user)/", re.I)


def resolve_live_id(text: str) -> str:
    """直播间地址 → 抓弹幕要用的 id。

    支持三种写法：
    - `https://live.douyin.com/123456789`（web_rid，会再去页面换 roomId）
    - `https://v.douyin.com/xxxx/`（App 分享短链，跟跳转到 reflow 后取 roomId）
    - `https://webcast.amemv.com/douyin/webcast/reflow/7700957723814628123`（直接是 roomId）
    """
    text = (text or "").strip()
    if not text:
        return ""
    live_id = parse_live_id(text)
    if live_id:
        return live_id
    m = re.search(r"/webcast/reflow/(\d{10,})", text)
    if m:
        return m.group(1)
    if not _SHORT_RE.search(text):
        return ""
    if not text.startswith("http"):
        text = "https://" + text
    try:
        import requests
        resp = requests.get(text, timeout=10, allow_redirects=True,
                            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                                                   "AppleWebKit/537.36 (KHTML, like Gecko) "
                                                   "Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0"})
    except Exception:
        return ""
    m = re.search(r"/webcast/reflow/(\d{10,})", resp.url or "")
    if m:
        return m.group(1)
    live_id = parse_live_id(resp.url) or parse_live_id(resp.text[:20000])
    if live_id:
        return live_id
    m = re.search(r'roomId\\?"?\s*:\s*\\?"?(\d{10,})', resp.text[:200000])
    return m.group(1) if m else ""


def is_room_id(value: str) -> bool:
    """19 位左右的全数字 = 抖音内部 roomId（可以直接连，不用再换）。"""
    return bool(re.fullmatch(r"\d{15,}", (value or "").strip()))


# ---------------------------------------------------------------- roomId 缓存
# 抖音页面偶尔会因为风控/频率返回不带 roomId 的壳页，缓存一份避免反复抓。

ROOM_CACHE = BASE_DIR / "data" / "roomids.json"


def load_room_cache() -> dict:
    try:
        return json.loads(ROOM_CACHE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def remember_room(web_rid: str, room_id: str) -> None:
    if not web_rid or not room_id:
        return
    cache = load_room_cache()
    if cache.get(web_rid) == room_id:
        return
    cache[web_rid] = room_id
    try:
        ROOM_CACHE.parent.mkdir(parents=True, exist_ok=True)
        ROOM_CACHE.write_text(json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError:
        pass


def fetcher_class():
    """构造上游 Fetcher 的子类（延迟 import，没装依赖时不影响服务启动）。"""
    global _FETCHER
    if _FETCHER is not None:
        return _FETCHER

    ok, msg = available()
    if not ok:
        raise RuntimeError(msg)

    import gzip as _gzip
    import liveMan
    import websocket
    from protobuf.douyin import (ChatMessage, GiftMessage, LikeMessage,
                                 MemberMessage, PushFrame, Response, SocialMessage)

    # 上游用相对路径找 sign.js，这里固定成绝对路径
    orig_sign = liveMan.generateSignature

    def _sign(wss, script_file=None):
        return orig_sign(wss, script_file or str(VENDOR / "sign.js"))

    liveMan.generateSignature = _sign

    class DouyinFetcher(liveMan.DouyinLiveWebFetcher):
        """真实弹幕：一条 WS 连接，解 protobuf，逐条翻译成本项目事件。"""

        def __init__(self, live_id: str, emit, log=None, status=None, cookie: str = "",
                     identity: str = "audience", api_version: str = "v2", did: str = "",
                     ws_host: str = ""):
            super().__init__(live_id, abogus_file=str(VENDOR / "a_bogus.js"))
            self._direct_room_id = live_id if is_room_id(live_id) else ""
            self._resolved_room_id = ""
            self._frames = 0
            self._emit_event = emit
            self._log = log or (lambda msg: None)
            self._status = status or (lambda **kw: None)
            # 每次会话一个随机设备号：上游把 did 写死成同一个值，多个爬虫共用
            # 这个号很容易被风控盯上（表现就是弹幕/进场有、礼物不下发）
            self._did = str(did or random.randint(10 ** 18, 10 ** 19 - 1))
            self._identity = (identity or "audience").strip()
            self._api_version = (api_version or "v2").strip().lstrip("v") or "2"
            self._ws_host = (ws_host or "webcast100-ws-web-lq.douyin.com").strip()
            # 登录态 Cookie（可选）：匿名连接只拿得到 进场/点赞/弹幕，
            # 礼物推送在部分房间要求登录态，这时把浏览器 Cookie 填进来即可。
            self._cookie = (cookie or "").strip()
            if self._cookie:
                for part in self._cookie.split(";"):
                    if "=" in part:
                        k, v = part.split("=", 1)
                        try:
                            self.session.cookies.set(k.strip(), v.strip())
                        except Exception:
                            pass
            # ---- 礼物诊断 ----
            self._gifts: dict[str, dict] = {}      # 连击缓冲 group_id -> 累计
            self._gift_ok = 0                      # 解析成功并上报的礼物条数
            self._gift_err: list[str] = []         # 最近的礼物解析异常
            self._gift_raw = 0                     # 收到的礼物消息原始条数
            self._methods: dict[str, int] = {}     # 收到的消息类型统计
            self._unknown: dict[str, int] = {}     # 未处理的消息类型
            self._errors: dict[str, str] = {}      # 解析异常 message 类型 -> 错误
            # ---- 帧级观测：礼物没到时，能证明「抖音到底推了什么」----
            self._recent: deque = deque(maxlen=24)  # (时间, 方法名, 字节数)
            self._last_frame_at = 0.0
            self._chat_count = 0
            self._gift_methods: dict[str, int] = {}  # 方法名里带 Gift 的帧计数

        # ---- 礼物诊断快照（控制台「抖音接入」里能看到）----
        def gift_debug(self) -> dict:
            return {
                "raw": self._gift_raw,
                "ok": self._gift_ok,
                "pending": len(self._gifts),
                "errors": self._gift_err[-3:],
                "chat": self._chat_count,
                "gift_methods": dict(self._gift_methods),
                "last_frame_at": (time.strftime("%H:%M:%S", time.localtime(self._last_frame_at))
                                  if self._last_frame_at else ""),
                "recent": [{"t": t, "m": m, "b": b} for t, m, b in list(self._recent)[-10:]],
                "methods": dict(sorted(self._methods.items(), key=lambda kv: -kv[1])[:8]),
                "unknown": dict(sorted(self._unknown.items(), key=lambda kv: -kv[1])[:6]),
                "parse_errors": dict(list(self._errors.items())[:5]),
            }

        def _log_frame(self, method: str, size: int) -> None:
            """礼物相关的帧单独落盘：事后能回答「抖音推没推礼物」。"""
            try:
                if FRAME_LOG.exists() and FRAME_LOG.stat().st_size > 512 * 1024:
                    FRAME_LOG.replace(FRAME_LOG.with_suffix(".log.1"))
                FRAME_LOG.parent.mkdir(parents=True, exist_ok=True)
                with open(FRAME_LOG, "a", encoding="utf-8") as fh:
                    fh.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')}\t{method}\t{size}\n")
            except OSError:
                pass

        def _note_method(self, method: str) -> None:
            self._methods[method] = self._methods.get(method, 0) + 1

        def _note_error(self, method: str, exc: Exception) -> None:
            msg = f"{type(exc).__name__}: {exc}"[:160]
            self._errors[method] = msg
            if method == "WebcastGiftMessage":
                self._gift_err.append(msg)
                self._gift_err = self._gift_err[-3:]
                self._log(f"礼物消息解析失败：{msg}")

        # ---- 帧计数：让界面能看出「连接活着、只是没人说话」----
        def _wsOnMessage(self, ws, message):
            self._frames += 1
            self._last_frame_at = time.time()
            self._flush_gifts(force=False)
            if self._frames == 1 or self._frames % 5 == 0:
                self._status(frames=self._frames, gift_debug=self.gift_debug())
            try:
                package = PushFrame().parse(message)
                response = Response().parse(_gzip.decompress(package.payload))
            except Exception as exc:      # 坏帧 / 压缩格式变化：记一笔，不炸线程
                self._note_error("frame", exc)
                return

            if response.need_ack:
                try:
                    ack = PushFrame(log_id=package.log_id, payload_type="ack",
                                    payload=response.internal_ext.encode("utf-8")).SerializeToString()
                    ws.send(ack, websocket.ABNF.OPCODE_BINARY)
                except Exception:
                    pass

            handlers = self._handler_map()
            for msg in response.messages_list:
                method = msg.method or "?"
                size = len(msg.payload or b"")
                self._note_method(method)
                self._last_frame_at = time.time()
                self._recent.append((time.strftime("%H:%M:%S"), method, size))
                if "Gift" in method:       # 任何带 Gift 的方法名都记下来（抖音可能改名字）
                    self._gift_methods[method] = self._gift_methods.get(method, 0) + 1
                    self._log_frame(method, size)
                elif method == "WebcastChatMessage":
                    self._chat_count += 1
                fn = handlers.get(method)
                if fn is None:
                    self._unknown[method] = self._unknown.get(method, 0) + 1
                    continue
                try:
                    fn(msg.payload)
                except Exception as exc:   # 上游这里是静默 pass，礼物「凭空消失」就查不出来
                    self._note_error(method, exc)

        def _handler_map(self) -> dict:
            return {
                "WebcastChatMessage": self._parseChatMsg,
                "WebcastGiftMessage": self._parseGiftMsg,
                "WebcastLikeMessage": self._parseLikeMsg,
                "WebcastMemberMessage": self._parseMemberMsg,
                "WebcastSocialMessage": self._parseSocialMsg,
            }

        def _connectWebSocket(self):
            """连 WS。和上游唯一的区别：把用户填的登录 Cookie 一起带上。

            匿名连接在部分房间只会推 进场/点赞/弹幕，礼物消息要求登录态；
            这时在控制台「抖音接入」里填一段浏览器 Cookie（含 sessionid/ttwid），
            礼物帧就能正常进来。
            """
            from websocket import WebSocketApp
            from liveMan import generateSignature
            extra = self._cookie
            ver = self._api_version
            host = self._ws_host
            wss = (f"wss://{host}/webcast/im/push/v{ver}/?app_name=douyin_web"
                   "&version_code=180800&webcast_sdk_version=1.0.14-beta.0"
                   "&update_version_code=1.0.14-beta.0&compress=gzip&device_platform=web&cookie_enabled=true"
                   "&screen_width=1536&screen_height=864&browser_language=zh-CN&browser_platform=Win32"
                   "&browser_name=Mozilla"
                   "&browser_version=5.0%20(Windows%20NT%2010.0;%20Win64;%20x64)%20AppleWebKit/537.36%20(KHTML,"
                   "%20like%20Gecko)%20Chrome/126.0.0.0%20Safari/537.36"
                   "&browser_online=true&tz_name=Asia/Shanghai"
                   "&cursor=d-1_u-1_fh-7392091211001140287_t-1721106114633_r-1"
                   f"&internal_ext=internal_src:dim|wss_push_room_id:{self.room_id}|wss_push_did:{self._did}"
                   f"|first_req_ms:1721106114541|fetch_time:1721106114633|seq:1|wss_info:0-1721106114633-0-0|"
                   f"wrds_v:7392094459690748497"
                   f"&host=https://live.douyin.com&aid=6383&live_id=1&did_rule=3&endpoint=live_pc&support_wrds=1"
                   f"&user_unique_id={self._did}&im_path=/webcast/im/fetch/&identity={self._identity}"
                   f"&need_persist_msg_count=15&insert_task_id=&live_reason=&room_id={self.room_id}&heartbeatDuration=0")
            wss += f"&signature={generateSignature(wss)}"
            cookie = f"ttwid={self.ttwid}"
            if extra:
                cookie += "; " + extra
                self._log("直连使用登录 Cookie（礼物推送按登录态下发）")
            headers = {"cookie": cookie, "user-agent": self.user_agent}
            self.ws = WebSocketApp(wss,
                                   header=headers,
                                   on_open=self._wsOnOpen,
                                   on_message=self._wsOnMessage,
                                   on_error=self._wsOnError,
                                   on_close=self._wsOnClose)
            try:
                self.ws.run_forever()
            except Exception:
                self.stop()
                raise

        # ---- 房间号解析：失败时给能看懂的错 ----
        @property
        def room_id(self):
            if self._direct_room_id:
                return self._direct_room_id
            if self._resolved_room_id:
                return self._resolved_room_id
            for attempt in range(3):
                rid = self._scrape_room_id()
                if rid:
                    self._resolved_room_id = rid
                    remember_room(self.live_id, rid)
                    return rid
                if attempt < 2:
                    time.sleep(1.5)
            cached = load_room_cache().get(self.live_id)
            if cached:
                self._log(f"页面没取到 roomId，改用缓存值 {cached}")
                self._resolved_room_id = cached
                return cached
            raise RuntimeError(
                "解析直播间 roomId 失败：确认直播间正在开播，地址形如 https://live.douyin.com/123456789")

        def _scrape_room_id(self):
            """自己抓 live.douyin.com/<web_rid> 页面里的 roomId（失败返回空）。"""
            import re as _re
            url = f"https://live.douyin.com/{self.live_id}"
            headers = {
                "User-Agent": self.user_agent,
                "cookie": f"ttwid={self.ttwid}&msToken={liveMan.generateMsToken()}; "
                          "__ac_nonce=0123407cc00a9e438deb4",
            }
            try:
                resp = self.session.get(url, headers=headers, timeout=10)
            except Exception:
                return ""
            m = _re.search(r'roomId\\?":\\?"(\d+)', resp.text or "")
            if not m:
                m = _re.search(r'roomId\\?\\?":\\?\\?"(\d+)', resp.text or "")
            return m.group(1) if m else ""

        # ---- 生命周期 ----
        def _wsOnOpen(self, ws):
            self._status(state="connected", last_error="")
            self._log(f"已连接抖音直播间 {self.live_id}（roomId {self.room_id}）")
            threading.Thread(target=self._sendHeartbeat, daemon=True).start()

        def _wsOnError(self, ws, error):
            self._status(state="error", last_error=str(error)[:160])
            self._log(f"弹幕连接异常：{error}")

        def _wsOnClose(self, ws, *args):
            self._flush_gifts(force=True)   # 断线前把没感谢完的连击礼物补上
            self._status(state="connecting")

        def _sendHeartbeat(self):
            """上游版会往 stdout 打日志，这里静音重写。"""
            while True:
                try:
                    self.ws.send(PushFrame(payload_type="hb").SerializeToString(),
                                 websocket.ABNF.OPCODE_PING)
                except Exception:
                    return
                time.sleep(5)

        # ---- 用不到、且上游会打印整段 protobuf 的消息：静音 ----
        def _ignored(self, payload):
            return None

        _parseRoomUserSeqMsg = _ignored
        _parseFansclubMsg = _ignored
        _parseEmojiChatMsg = _ignored
        _parseRoomMsg = _ignored
        _parseRoomStatsMsg = _ignored
        _parseRankMsg = _ignored
        _parseControlMsg = _ignored
        _parseRoomStreamAdaptationMsg = _ignored

        # ---- 消息翻译 ----
        def _parseChatMsg(self, payload):
            m = ChatMessage().parse(payload)
            self._emit_event({
                "kind": "comment",
                "username": m.user.nick_name or "观众",
                "text": (m.content or "").strip(),
                "user_id": str(m.user.id or ""),
                "event_id": f"c{m.common.msg_id}" if m.common else "",
                # 抖音连上时会把最近的历史弹幕一起推下来，用 create_time 区分新旧
                "ts": int(getattr(m.common, "create_time", 0) or 0) if m.common else 0,
            })

        def _parseGiftMsg(self, payload):
            """礼物消息：兼容单次礼物和连击礼物。

            抖音的连击礼物会连推多条 `WebcastGiftMessage`（combo_count 递增，
            最后一条 repeat_end=1）。以前按 group_id 去重，结果第一条之后就全被
            丢掉，看起来就像「礼物收不到」。这里改成聚合：连击先攒着，等
            repeat_end 或 2.5 秒没动静再一次性感谢总数。
            """
            self._gift_raw += 1
            m = GiftMessage().parse(payload)
            gift = m.gift
            name = ""
            if gift is not None:
                name = (gift.name or "").strip() or (gift.describe or "").strip()
            if not name and getattr(m, "tray_display_text", None):
                name = (m.tray_display_text.content or "").strip()
            gid = str(m.gift_id or (gift.id if gift is not None else "") or "")
            if not name:
                name = f"礼物{gid}" if gid else "礼物"
            name = name[:40]

            combo = int(m.combo_count or 0)
            repeat = int(m.repeat_count or 0)
            group_count = int(m.group_count or 0)
            total_count = int(getattr(m, "total_count", 0) or 0)
            count = max(combo, repeat, group_count, total_count, 1)
            diamond = int((gift.diamond_count if gift is not None else 0) or 0)
            # 顺手把「名字 / 抖币 / 图标」记进礼物表，控制台图鉴会自己长全
            icon_url = ""
            if gift is not None:
                for img in (getattr(gift, "icon", None), getattr(gift, "image", None)):
                    urls = list(getattr(img, "url_list", None) or []) if img is not None else []
                    if urls:
                        icon_url = str(urls[0])
                        break
            describe = str((gift.describe if gift is not None else "") or "")[:60]
            if name and name != "礼物":
                gifts.learn_async(name, gid, diamond, icon_url, describe)
            group = str(m.group_id or "")
            repeat_end = int(m.repeat_end or 0)
            combo_gift = bool(getattr(gift, "combo", False)) if gift is not None else False
            user = (m.user.nick_name if m.user else "") or "观众"
            uid = str(m.user.id or "") if m.user else ""
            now = time.time()

            if combo_gift and group and not repeat_end:
                entry = self._gifts.get(group)
                if entry:
                    entry["count"] = max(entry["count"], count)
                    entry["total"] = max(entry["total"], total_count)
                    entry["last"] = now
                    entry["name"] = entry["name"] or name
                    entry["diamond"] = entry["diamond"] or diamond
                else:
                    self._gifts[group] = {
                        "name": name, "count": count, "total": total_count,
                        "diamond": diamond, "user": user, "uid": uid,
                        "gift_id": gid, "last": now,
                    }
                self._status(gift_debug=self.gift_debug())
                return

            if group and group in self._gifts:
                entry = self._gifts.pop(group)
                count = max(entry["count"], entry["total"], count)
                diamond = diamond or entry["diamond"]
                name = entry["name"] or name
                user = entry["user"] or user
                uid = entry["uid"] or uid
            self._emit_gift(name, count, diamond, user, uid, gid, group, combo_gift)

        def _emit_gift(self, name: str, count: int, diamond: int, user: str,
                       uid: str, gid: str, group: str, combo_gift: bool) -> None:
            self._gift_ok += 1
            self._emit_event({
                "kind": "gift",
                "username": user,
                "gift": name,
                "count": int(count or 1),
                "diamond": int(diamond or 0),
                # 10 抖币 ≈ 1 元；拿不到单价就交给上层按价目表兜底
                "value": round(int(diamond or 0) * int(count or 1) / 10.0, 1),
                "user_id": uid,
                "gift_id": gid,
                "combo": bool(combo_gift),
                # 同一个连击组只谢一次：group + 最终数量；没有 group 时按秒去重防重推
                "event_id": (f"g{group}-{int(count or 1)}" if group
                             else f"g{user}-{gid}-{int(count or 1)}-{int(time.time())}"),
                "ts": time.time(),
            })
            self._status(gift_debug=self.gift_debug())

        def _flush_gifts(self, force: bool = False, ttl: float = 2.5) -> None:
            """连击礼物 2.5 秒没新消息就当作结束（repeat_end 有时不会来）。"""
            if not self._gifts:
                return
            now = time.time()
            for group in [g for g, e in self._gifts.items() if force or now - e["last"] >= ttl]:
                entry = self._gifts.pop(group, None)
                if not entry:
                    continue
                count = max(entry["count"], entry["total"], 1)
                self._emit_gift(entry["name"], count, entry["diamond"], entry["user"],
                                entry["uid"], entry["gift_id"], group, True)

        def _parseLikeMsg(self, payload):
            m = LikeMessage().parse(payload)
            self._emit_event({
                "kind": "like",
                "username": m.user.nick_name or "观众",
                "user_id": str(m.user.id or "") if m.user else "",
                "count": int(m.count or 1),
                "event_id": f"l{m.common.msg_id}" if m.common else "",
            })

        def _parseMemberMsg(self, payload):
            m = MemberMessage().parse(payload)
            self._emit_event({
                "kind": "enter",
                "username": m.user.nick_name or "观众",
                "user_id": str(m.user.id or "") if m.user else "",
                "event_id": f"e{m.common.msg_id}" if m.common else "",
            })

        def _parseSocialMsg(self, payload):
            m = SocialMessage().parse(payload)
            if int(m.action or 0) not in (0, 1):  # 1 = 关注
                return
            self._emit_event({
                "kind": "follow",
                "username": m.user.nick_name or "观众",
                "event_id": f"f{m.common.msg_id}" if m.common else "",
            })

    _FETCHER = DouyinFetcher
    return _FETCHER


class LiveSession:
    """跑在后台线程里的直连会话：连上就一直收，断了自动重连。"""

    def __init__(self, live_id: str, emit, log=None, status=None, should_run=None,
                 cookie: str = "", identity: str = "audience", api_version: str = "v2",
                 did: str = "", ws_host: str = ""):
        self.live_id = str(live_id)
        self.emit = emit
        self.log = log or (lambda msg: None)
        self.status = status or (lambda **kw: None)
        self.should_run = should_run or (lambda: True)
        self.cookie = (cookie or "").strip()
        self.identity = (identity or "audience").strip()
        self.api_version = (api_version or "v2").strip()
        self.did = (did or "").strip()
        self.ws_host = (ws_host or "").strip()
        self._fetcher = None
        self._lock = threading.Lock()

    def run(self) -> None:
        try:
            cls = fetcher_class()
        except RuntimeError as exc:
            self.status(state="error", last_error=str(exc))
            self.log(str(exc))
            return

        backoff = 8.0
        shown = ("https://webcast.amemv.com/douyin/webcast/reflow/" + self.live_id
                 if is_room_id(self.live_id) else f"https://live.douyin.com/{self.live_id}")
        while self.should_run():
            self.status(state="connecting", url=shown)
            fetcher = cls(self.live_id, self.emit, log=self.log, status=self.status,
                          cookie=self.cookie, identity=self.identity,
                          api_version=self.api_version, did=self.did, ws_host=self.ws_host)
            with self._lock:
                self._fetcher = fetcher
            stop_watch = threading.Event()

            def watch(f=fetcher, ev=stop_watch):
                """上游 run_forever 没设 ping，半死的连接会一直挂着；这里盯住数据帧。"""
                last, idle = -1, 0
                while not ev.wait(15):
                    if not self.should_run():
                        return
                    cur = getattr(f, "_frames", 0)
                    if cur == last:
                        idle += 15
                        if idle >= 90:
                            self.log("90 秒没有新数据帧，主动重连…")
                            try:
                                f.ws.close()
                            except Exception:
                                pass
                            return
                    else:
                        idle, last = 0, cur

            threading.Thread(target=watch, daemon=True).start()
            try:
                fetcher.start()  # 内部 run_forever，阻塞到断开
            except Exception as exc:
                self.status(state="error", last_error=f"{type(exc).__name__}: {str(exc)[:140]}")
                self.log(f"连接失败：{exc}")
            finally:
                with self._lock:
                    self._fetcher = None
            if not self.should_run():
                break
            self.log(f"{int(backoff)} 秒后重连…")
            for _ in range(int(backoff)):
                if not self.should_run():
                    return
                time.sleep(1)
            backoff = min(60.0, backoff * 1.6)

    def stop(self) -> None:
        with self._lock:
            fetcher = self._fetcher
        if fetcher is None:
            return
        try:
            fetcher.ws.close()
        except Exception:
            pass
