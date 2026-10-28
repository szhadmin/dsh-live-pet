"""抖音直播接入层。

三种来源：
- live     ：直连抖音网页版直播间（开源 DouyinLiveWebFetcher，真实弹幕/礼物/进场/点赞）
- bridge   ：连接本机弹幕监听程序（ws://127.0.0.1:8888）的 WebSocket，自动重连
- webhook  ：不主动连接，等外部监听器把事件 POST 到 /api/event

所有来源最终归一成统一事件：
{"kind":"comment|gift|follow|enter|like","username":str,"text":str,"gift":str,"count":int,"event_id":str}
"""
from __future__ import annotations

import json
import threading
import time
from datetime import datetime

STATE_LOCK = threading.Lock()
_STATE = {
    "mode": "off",
    "state": "stopped",      # stopped | connecting | connected | error
    "url": "",
    "messages": 0,
    "frames": 0,
    "reconnects": 0,
    "last_message_at": "",
    "last_error": "",
    "started_at": "",
}

KIND_ALIASES = {
    "comment": "comment", "chat": "comment", "danmu": "comment", "danmaku": "comment",
    "弹幕": "comment", "webcastchatmessage": "comment", "1": "comment",
    "gift": "gift", "礼物": "gift", "webcastgiftmessage": "gift", "2": "gift",
    "follow": "follow", "关注": "follow", "social": "follow", "webcastsocialmessage": "follow", "3": "follow",
    "enter": "enter", "member": "enter", "进场": "enter", "webcastmembermessage": "enter", "4": "enter",
    "like": "like", "点赞": "like", "webcastlikemessage": "like",
}

_watchdog: threading.Thread | None = None
_stop_flag = threading.Event()
_ws = None
_live = None      # 直连会话（core.douyin_live.LiveSession）
_GEN = 0          # 每次 start 递增，旧线程凭代数自行退出，避免双份推送


def status() -> dict:
    with STATE_LOCK:
        return dict(_STATE)


def _set(**kw) -> None:
    with STATE_LOCK:
        _STATE.update(kw)


def _pick(data: dict, *keys, default=""):
    for k in keys:
        if k in data and data[k] not in (None, ""):
            return data[k]
    return default


def normalize(raw) -> list[dict]:
    """把各种弹幕监听器的消息归一化，返回事件列表。"""
    if isinstance(raw, bytes):
        try:
            raw = raw.decode("utf-8", errors="ignore")
        except Exception:
            return []
    if isinstance(raw, str):
        raw = raw.strip()
        if not raw:
            return []
        if not raw.startswith(("{", "[")):
            return []
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            return []
    items = raw if isinstance(raw, list) else [raw]
    out: list[dict] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        method = str(_pick(item, "method", "Method", "type", "Type", "kind", "cmd", "msg_type")).lower()
        kind_raw = _pick(item, "kind", "Type", "type", "msg_type", "")
        kind = KIND_ALIASES.get(str(kind_raw).lower(), "")
        if not kind:
            kind = KIND_ALIASES.get(method, "")
        if not kind:
            if method.startswith("webcastchatmessage"):
                kind = "comment"
            elif method.startswith("webcastgiftmessage"):
                kind = "gift"
            elif method.startswith("webcastmembermessage"):
                kind = "enter"
            elif method.startswith("webcastsocialmessage"):
                kind = "follow"
            elif method.startswith("webcastlikemessage"):
                kind = "like"
        if not kind:
            continue
        user = _pick(item, "username", "user_name", "UserName", "nickname", "nick_name", "uname")
        if not user and isinstance(item.get("user"), dict):
            user = _pick(item["user"], "nickname", "nick_name", "name", "display_id", "id")
        if not user and isinstance(item.get("User"), dict):
            user = _pick(item["User"], "Nickname", "NickName", "Name")
        text = _pick(item, "text", "content", "Content", "msg", "message")
        gift = _pick(item, "gift", "gift_name", "GiftName", "giftName")
        if not gift and isinstance(item.get("gift"), dict):
            gift = _pick(item["gift"], "name", "describe")
        count = _pick(item, "count", "gift_count", "GiftCount", "combo_count", default=1)
        try:
            count = max(1, int(count))
        except (TypeError, ValueError):
            count = 1
        event_id = str(_pick(item, "event_id", "msg_id", "MsgId", "id", default=""))
        if not event_id:
            event_id = f"{user}-{kind}-{text or gift}-{int(time.time() * 1000)}"
        if kind == "comment" and not str(text).strip():
            continue
        # 礼物价值透传：外部监听器 / 桥接器带上 diamond（抖币）或 value（元）就按它算，
        # 否则 app 侧只能靠价目表猜，大礼物会被算成 0.1 元。
        diamond = _pick(item, "diamond", "diamond_count", "DiamondCount", default=0)
        value = _pick(item, "value", "gift_value", "GiftValue", default=None)
        try:
            diamond = max(0, int(diamond or 0))
        except (TypeError, ValueError):
            diamond = 0
        try:
            value = None if value in (None, "") else float(value)
        except (TypeError, ValueError):
            value = None
        event = {
            "kind": kind,
            "username": str(user or "路人")[:40],
            "text": str(text or "")[:300],
            "gift": str(gift or "")[:40],
            "count": count,
            "event_id": event_id[:80],
        }
        if diamond:
            event["diamond"] = diamond
        if value is not None:
            event["value"] = value
        if item.get("ts"):
            event["ts"] = item["ts"]
        out.append(event)
    return out


def _port_open(url: str, timeout: float = 0.6) -> bool:
    """弹幕桥地址能不能连上（bridge 模式启动前先探一下，避免无意义的死循环重连）。"""
    import socket
    from urllib.parse import urlparse
    parsed = urlparse(url if "://" in url else f"ws://{url}")
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port or (443 if parsed.scheme in ("wss", "https") else 80)
    try:
        with socket.socket() as probe:
            probe.settimeout(timeout)
            return probe.connect_ex((host, port)) == 0
    except OSError:
        return False


def start(mode: str, url: str, on_event, on_log=None, cookie: str = "",
          identity: str = "audience", api_version: str = "v2", did: str = "",
          ws_host: str = "") -> dict:
    """启动数据源；on_event 会被工作线程调用。cookie 仅在 live 模式用得上。"""
    global _watchdog, _GEN
    stop()
    with STATE_LOCK:
        _GEN += 1
        gen = _GEN
    _stop_flag.clear()
    _set(mode=mode, state="stopped", url=url if mode in ("bridge", "live") else "", messages=0,
         frames=0, reconnects=0, last_error="", started_at=datetime.now().isoformat(timespec="seconds"))
    if mode in ("off", "webhook"):
        _set(state="stopped" if mode == "off" else "connected")
        return status()
    if mode == "live":
        from core import douyin_live
        live_id = douyin_live.resolve_live_id(url)
        if not live_id:
            _set(state="error", last_error="请填写直播间地址，例如 https://live.douyin.com/123456789（App 分享的 v.douyin.com 短链也可以）")
            return status()
        ok, msg = douyin_live.available()
        if not ok:
            _set(state="error", last_error=msg)
            return status()
        _set(state="connecting", live_id=live_id,
             url=(f"https://webcast.amemv.com/douyin/webcast/reflow/{live_id}"
                  if douyin_live.is_room_id(live_id) else f"https://live.douyin.com/{live_id}"))
        _watchdog = threading.Thread(target=_live_loop, args=(live_id, on_event, on_log, gen, cookie, identity, api_version, did, ws_host),
                                     daemon=True)
        _watchdog.start()
        return status()
    if mode == "bridge":
        if not _port_open(url):
            _set(state="error", last_error=(
                f"{url} 没有弹幕监听程序在监听（10061）｜想直连抖音请把模式切到 live，"
                "或在 8888 端口起你自己的弹幕监听器"))
            return status()
        _watchdog = threading.Thread(target=_bridge_loop, args=(url, on_event, on_log, gen), daemon=True)
        _watchdog.start()
        return status()
    _set(state="error", last_error=f"未知模式 {mode}")
    return status()


def stop() -> dict:
    global _ws, _GEN, _live
    _stop_flag.set()
    with STATE_LOCK:
        _GEN += 1
    session = _live
    _live = None
    if session is not None:
        try:
            session.stop()
        except Exception:
            pass
    try:
        if _ws is not None:
            _ws.close()
    except Exception:
        pass
    _ws = None
    _set(state="stopped")
    return status()


# ---------------------------------------------------------------- 桥接 WebSocket

def _bridge_loop(url: str, on_event, on_log, gen: int) -> None:
    try:
        import websocket  # websocket-client
    except ImportError:
        _set(state="error", last_error="缺少 websocket-client，请 pip install websocket-client")
        return

    backoff = 2.0
    while not _stop_flag.is_set() and gen == _GEN:
        _set(state="connecting", url=url)

        def on_message(ws, message):
            if gen != _GEN:
                return
            events = normalize(message)
            for ev in events:
                _set(messages=status()["messages"] + 1,
                     last_message_at=datetime.now().strftime("%H:%M:%S"))
                try:
                    on_event(ev)
                except Exception as exc:
                    if on_log:
                        on_log(f"事件处理失败：{exc}")

        def on_open(ws):
            _set(state="connected", last_error="")
            backoff_reset()
            if on_log:
                on_log(f"已连接弹幕桥 {url}")

        def on_error(ws, error):
            text = str(error)[:160]
            if "10061" in text or "refused" in text.lower() or "拒绝" in text:
                text += "｜这个端口没有弹幕监听程序：想直连抖音请把模式切到 live"
            _set(state="error", last_error=text)

        def on_close(ws, code, msg):
            _set(state="stopped" if _stop_flag.is_set() else "connecting")

        def backoff_reset():
            nonlocal backoff
            backoff = 2.0

        global _ws
        _ws = websocket.WebSocketApp(url, on_open=on_open, on_message=on_message,
                                     on_error=on_error, on_close=on_close)
        try:
            _ws.run_forever(ping_interval=25, ping_timeout=10)
        except Exception as exc:
            _set(state="error", last_error=str(exc)[:160])
        if _stop_flag.is_set() or gen != _GEN:
            break
        _set(reconnects=status()["reconnects"] + 1)
        time.sleep(backoff)
        backoff = min(30.0, backoff * 1.6)


# ---------------------------------------------------------------- 抖音直连

def _live_loop(live_id: str, on_event, on_log, gen: int, cookie: str = "",
               identity: str = "audience", api_version: str = "v2", did: str = "",
               ws_host: str = "") -> None:
    """抖音网页版直连：真实弹幕 / 礼物 / 进场 / 点赞 / 关注。"""
    from core import douyin_live

    global _live

    def emit(ev: dict) -> None:
        if gen != _GEN or _stop_flag.is_set():
            return
        _set(messages=status()["messages"] + 1,
             last_message_at=datetime.now().strftime("%H:%M:%S"))
        try:
            on_event(ev)
        except Exception as exc:
            if on_log:
                on_log(f"事件处理失败：{exc}")

    def should_run() -> bool:
        return gen == _GEN and not _stop_flag.is_set()

    session = douyin_live.LiveSession(live_id, emit, log=on_log, status=_set,
                                      should_run=should_run, cookie=cookie,
                                      identity=identity, api_version=api_version, did=did,
                                      ws_host=ws_host)
    _live = session
    try:
        session.run()
    finally:
        if gen == _GEN:
            _set(state="stopped")
        if _live is session:
            _live = None
