"""大肥鲸在线直播 · 服务端。

一个进程搞定：控制台 / OBS 舞台 / 抖音弹幕接入 / 有记忆的智能体 / Edge-TTS 语音。
只用标准库 + edge-tts（+ 可选 websocket-client 用于弹幕桥）。
"""
from __future__ import annotations

import argparse
import json
import os
import queue
import random
import re
import socket
import sys
import threading
import time
import urllib.error
import webbrowser
from collections import deque
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from core import (brain, config, douyin, gift_actions, gifts, harness, mate_log, memory,
                  music, names, songs, tools, tts)

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from core.paths import BASE_DIR, GIFS_DIR, SONGS_DIR, WEB_DIR, ensure_user_files

ROOT = BASE_DIR
WEB = WEB_DIR
GIFS = GIFS_DIR
SONGS = SONGS_DIR
AUDIO = config.DATA_DIR / "audio"

HOST, PORT = "0.0.0.0", 8790
LOCK = threading.RLock()
EVENTS = deque(maxlen=200)
# 只读弹幕流水：给外部消费方（DSH 插件 dsh-live-pet）读「原始入站事件」用。
# EVENTS 里只有回复/口播/礼物这类业务记录，不含观众原话；这里独立记一份，不改原流程。
INBOUND = deque(maxlen=400)
INBOUND_SEQ = [0]
# claim=1 时推进的独占游标：一行只交给一个消费者
INBOUND_CLAIM = [0]
QUEUE: "queue.PriorityQueue" = queue.PriorityQueue()
SEEN: deque = deque(maxlen=4000)
SEEN_SET: set[str] = set()
LAST_REPLY_AT: dict[str, float] = {}
REPLY_TIMES: deque = deque(maxlen=200)
NOTICE_AT: dict[str, float] = {}
NOTICE_USER: dict[str, dict[str, float]] = {}
_seq = 0
_worker_started = False

# 常见礼物的人民币参考价（拿不到 diamond 时兜底；有 diamond 就按 10 抖币=1 元 算）
GIFT_VALUES = {
    "小心心": 0.1, "玫瑰": 0.5, "棒棒糖": 0.9, "甜甜圈": 5.2, "你最好看": 3.0,
    "大啤酒": 2.0, "加油鸭": 1.0, "真爱玫瑰": 5.0, "小星星": 1.0, "比心": 1.0,
    "浪漫花火": 59.9, "跑车": 1200.0, "飞机": 300.0, "火箭": 1000.0,
    "抖音1号": 1000.1, "嘉年华": 3000.0, "城堡": 3000.0, "游艇": 1888.0,
}

# 礼物动作状态（舞台按 id 变化播放特效）
ACTION_SEQ = {"id": 0}

STATE = {
    "status": "idle",
    "reply": "我是大肥鲸，深海工位 0001 号打工人。发条弹幕，我开始干活。",
    "username": "大肥鲸",
    "comment": "欢迎来到深海工位",
    "emotion": "calm",
    "gif": "whale_walking",
    "provider": "待机",
    "requests": 0,
    "input_tokens": 0,
    "output_tokens": 0,
    "gifts": 0,
    "gift_value": 0.0,
    "last_gift": "",
    "action": {"id": 0, "name": "", "fx": "", "gif": "", "hold": 6.0,
               "text": "", "user": "", "gift": "", "at": 0},
    "audio_id": 0,
    "audio_url": "",
    "audio_duration": 0,
    "audio_pending": False,
    "facts_used": [],
    "new_facts": [],
    "music": {
        "id": 0, "playing": False, "title": "", "url": "", "user": "", "gift": "",
        "duration": 0, "seq": 0, "volume": 0.55,
    },
    "last_activity": time.time(),
    "started_at": datetime.now().isoformat(timespec="seconds"),
    "queue": 0,
}


# ---------------------------------------------------------------- 工具

def add_event(kind: str, text: str, user: str = "") -> None:
    with LOCK:
        EVENTS.appendleft({
            "time": datetime.now().strftime("%H:%M:%S"),
            "kind": kind,
            "user": user,
            "text": text,
        })


AUDIENCE_KINDS = ("comment", "gift", "enter", "like", "follow")


def add_inbound(kind: str, user: str, text: str) -> None:
    """记一条原始入站事件，供 GET /api/feed 增量读取（只记录，不改变任何业务行为）。"""
    with LOCK:
        INBOUND_SEQ[0] += 1
        INBOUND.append({
            "id": INBOUND_SEQ[0],
            "at": round(time.time(), 3),
            "kind": kind,
            "user": user,
            "text": text,
        })


_MENU_CACHE: dict = {"at": 0.0, "sig": "", "rows": []}


def gift_menu_cached(cfg: dict, ttl: float = 5.0) -> list[dict]:
    """舞台每 600ms 拉一次 state，刷礼菜单做 5 秒缓存，别每次都算。"""
    names = tuple(gift_actions.menu_names(cfg))
    acts = tuple(sorted(((cfg.get("gift_actions") or {}).get("actions") or {}).items(),
                        key=lambda kv: kv[0]))
    sig = repr((names, acts, (cfg.get("gift_actions") or {}).get("rules") and
                len(cfg["gift_actions"]["rules"]) or 0))
    now = time.time()
    if _MENU_CACHE["rows"] and _MENU_CACHE["sig"] == sig and now - _MENU_CACHE["at"] < ttl:
        return _MENU_CACHE["rows"]
    rows = gift_actions.menu(cfg)
    _MENU_CACHE.update(at=now, sig=sig, rows=rows)
    return rows


def snapshot() -> dict:
    cfg = config.load()
    with LOCK:
        data = dict(STATE)
        # 礼物动作有停留时间：超过 hold 秒就回到情绪图，别一直钉在动作图上
        act = data.get("action") or {}
        hold = float(act.get("hold") or 0)
        at = float(act.get("at") or 0)
        if hold and at and (time.time() - at) > hold:
            data["gif"] = brain.EMOTIONS.get(str(data.get("emotion") or "calm"),
                                             "whale_walking")
        data["events"] = list(EVENTS)[:30]
        data["queue"] = QUEUE.qsize()
        data["memory_stats"] = memory.stats()
        data["douyin"] = douyin.status()
        data["music"] = dict(STATE["music"])
        data["music_queue"] = songs.JUKEBOX.status()
        data["tool_catalog"] = tools.CATALOG
        data["tools_on"] = bool((cfg.get("tools") or {}).get("enable", True))
        idle_cfg = cfg.get("idle") or {}
        data["idle"] = {
            "enable": bool(idle_cfg.get("enable", True)),
            "seconds": float(idle_cfg.get("seconds", 30)),
            "gap": round(idle_gap(idle_cfg), 1),
            "silent": round(time.time() - STATE["last_activity"], 1),
            "busy": _idle_busy,
            "count": len(_idle_said),
            "last": _idle_history[-1] if _idle_history else "",
        }
        data["settings"] = config.public(cfg)
        data["gift_menu"] = gift_menu_cached(cfg)
        promo_cfg = cfg.get("promo") or {}
        data["promo"] = {
            "enable": bool(promo_cfg.get("enable", True)),
            "seconds": float(promo_cfg.get("seconds", 240)),
            "left": max(0.0, round(float(promo_cfg.get("seconds", 240))
                                   - (time.time() - _promo_last), 1)) if _promo_last else 0.0,
            "count": len(_promo_said),
            "last": _promo_history[-1] if _promo_history else "",
        }
        data["auto_dj"] = {"busy": bool(_DJ["busy"]), "last": _DJ["last"]}
        data["harness"] = harness.status(cfg)
        data["mate_log"] = dict((_MATE.stats if _MATE else {}), attached=bool(_MATE))
        data["agent"] = brain.agent_state()
        data["uptime"] = int(time.time() - datetime.fromisoformat(STATE["started_at"]).timestamp())
    return data


def gif_url(name: str) -> str:
    return f"/gifs/{name}.gif"


def pick_gif(emotion: str) -> str:
    """返回动图文件主干名（如 whale_happy）；格式由舞台按配置选择 WebP/GIF。"""
    return brain.EMOTIONS.get(emotion, "whale_walking")


# ---------------------------------------------------------------- 自动 DJ：开播先放抖音热歌

_DJ = {"busy": False, "at": 0.0, "last": ""}


def auto_dj_start(cfg: dict | None = None, reason: str = "开播") -> bool:
    """开播 / 队列空了 → 自动放一首抖音热歌（观众礼物点歌永远排在它前面）。"""
    cfg = cfg or config.load()
    scfg = cfg.get("songs") or {}
    if not scfg.get("enable", True) or not scfg.get("auto_dj", True):
        return False
    if reason != "开播" and not scfg.get("auto_dj_keep", True):
        return False
    with LOCK:
        if _DJ["busy"]:
            return False
        _DJ["busy"] = True
    threading.Thread(target=_auto_dj_worker, args=(cfg, reason), daemon=True).start()
    return True


def _auto_dj_worker(cfg: dict, reason: str) -> None:
    try:
        scfg = cfg.get("songs") or {}
        if reason == "开播":
            delay = float(scfg.get("auto_dj_delay") or 0)
            if delay > 0:
                time.sleep(min(30.0, delay))     # 让开场的欢迎语先说完
        with LOCK:
            if reason != "开播" and STATE["music"]["playing"]:
                return                           # 已经在放，不插队
        hot: list[dict] = []
        try:
            hot = music.hot_douyin(cfg, limit=8, budget=4.0)
        except Exception:
            hot = []
        query = ""
        if hot:
            pick = random.choice(hot)
            query = f"{pick['name']} {pick['artist']}"
        r = songs.JUKEBOX.request("DJ大肥鲸", query, gift="自动DJ", priority=0,
                                  max_queue=int(scfg.get("max_queue", 10)), cfg=cfg)
        if not r.get("ok"):
            add_event("skip", f"自动 DJ 没排上：{r.get('reason') or '未知'}")
            return
        title = str(r["song"].get("title") or "")
        _DJ["last"] = title
        _DJ["at"] = time.time()
        add_event("music", f"♫ 自动 DJ（{reason}）：《{title}》")
        with LOCK:
            playing = bool(STATE["music"]["playing"])
        if not playing:
            play_song(songs.JUKEBOX.start_next(), config.load())
    except Exception as exc:
        add_event("error", f"自动 DJ 失败：{str(exc)[:100]}")
    finally:
        with LOCK:
            _DJ["busy"] = False


# ---------------------------------------------------------------- 礼物点歌

FREE_SONG_AT: dict[str, float] = {}

# ---------------------------------------------------------------- 冷场自己找话题

_idle_last = 0.0            # 上次自主发言的时间戳
_idle_step = 0              # 连续冷场次数（用来逐步拉长间隔）
_idle_busy = False          # 正在生成/播放自主发言
_idle_history: list[str] = []          # 最近说过的话，避免重复
_idle_said: list[float] = []           # 每小时发言计数

# ---------------------------------------------------------------- 定时口播（点赞 / 关注 / 小心心）
_promo_last = 0.0                     # 上次口播时间戳
_promo_said: list[float] = []          # 每小时口播计数
_promo_history: list[str] = []         # 最近说过的口播，避免重复


def promo_gap(cfg: dict) -> float:
    p = cfg.get("promo") or {}
    return max(30.0, float(p.get("seconds", 240)))


def promo_tick() -> bool:
    """工作线程空闲时调用：到点就排一条口播，返回是否排上了。"""
    global _promo_last
    cfg = config.load()
    p = cfg.get("promo") or {}
    if not p.get("enable", True):
        return False
    now = time.time()
    gap = promo_gap(cfg)
    if _promo_last and now - _promo_last < max(float(p.get("min_gap", 150)), 30.0):
        return False
    if _promo_last and now - _promo_last < gap:
        return False
    with LOCK:
        if STATE["status"] in ("thinking", "speaking") or STATE["audio_pending"]:
            return False
        music_on = bool(STATE["music"].get("playing"))
        # 刚送过礼物 / 刚有弹幕：先让那条把动作和动图演完，别马上抢镜头
        last_gift_at = STATE["action"].get("at") or 0
        quiet_for = 30.0
        if last_gift_at and now - float(last_gift_at) < quiet_for:
            return False
    if now - STATE.get("last_activity", 0) < 12.0:
        return False          # 刚说完一句话，缓一下再插口播
    if music_on and not p.get("with_music", True):
        return False
    if QUEUE.qsize() >= 3:
        return False          # 积压太多就先不插嘴，弹幕更要紧
    cap = int(p.get("max_per_hour", 12))
    _promo_said[:] = [t for t in _promo_said if now - t < 3600]
    if len(_promo_said) >= cap:
        return False
    _promo_last = now
    _promo_said.append(now)
    return enqueue({"kind": "promo", "username": cfg["host"]["name"]}, "auto")


def idle_gap(idle: dict) -> float:
    """当前该等多久：grow 打开时 30 → 45 → 60 …（上限 max_gap）。"""
    base = max(5.0, float(idle.get("seconds", 30)))
    if not idle.get("grow", True):
        return base
    cap = max(base, float(idle.get("max_gap", 150)))
    return min(cap, base * (1 + _idle_step * 0.5))


def idle_hint() -> str:
    """给模型一点上下文：最近直播间发生过什么。"""
    lines: list[str] = []
    try:
        for h in memory.highlights(3):
            text = (h.get("text") or "").strip()
            if text:
                lines.append(f"- {text[:60]}")
    except Exception:
        pass
    with LOCK:
        user = STATE.get("username") or ""
        comment = STATE.get("comment") or ""
    if user and comment:
        lines.append(f"- 最近一条弹幕：{user}：{comment[:40]}")
    return "\n".join(lines)


def idle_tick() -> None:
    """工作线程空闲时调用：判断要不要自己开口。"""
    global _idle_busy, _idle_last, _idle_said
    cfg = config.load()
    idle = cfg.get("idle") or {}
    if not idle.get("enable", True):
        return
    now = time.time()
    gap = idle_gap(idle)
    with LOCK:
        silent = now - STATE["last_activity"]
        busy = STATE["status"] in ("thinking", "speaking") or STATE["audio_pending"]
        music = bool(STATE["music"].get("playing"))
        pending = QUEUE.qsize()
    if _idle_busy or busy or music or pending:
        return
    if silent < gap or now - _idle_last < gap:
        return
    cap = int(idle.get("max_per_hour", 30))
    _idle_said = [t for t in _idle_said if now - t < 3600]
    if len(_idle_said) >= cap:
        return
    _idle_busy = True
    _idle_last = now
    _idle_said.append(now)
    threading.Thread(target=_idle_say, args=(cfg,), daemon=True).start()


def _idle_say(cfg: dict) -> None:
    """生成一句自主话题 → 合成语音 → 推给舞台。"""
    global _idle_busy, _idle_step
    started = time.time()
    try:
        result = brain.idle_topic(cfg, avoid=list(_idle_history), hint=idle_hint(), stats=live_stats())
        text = (result.get("reply") or "").strip()
        if not text:
            return
        with LOCK:
            # 生成期间有人说话 / 队列来了新事件 → 这条不说了
            if STATE["last_activity"] > started or QUEUE.qsize() > 0:
                add_event("system", "冷场话题取消：有人说话了")
                return
            host = cfg["host"]["name"]
            STATE.update(
                reply=text,
                username=host,
                comment="冷场救场：自己找话题",
                emotion=result.get("emotion", "calm"),
                gif=pick_gif(result.get("emotion", "calm")),
                provider=result.get("provider", "自主发言"),
                facts_used=[],
                new_facts=[],
                audio_pending=True,
                status="thinking",
                last_activity=time.time(),
            )
        add_event("idle", f"🌊 冷场自己找话题：{text}")
        memory.add_turn(cfg["host"]["name"], "host", text, result.get("emotion", "calm"))
        _idle_history.append(text)
        del _idle_history[:-8]

        speech = tts.synth(text, cfg["voice"], cfg["rate"], cfg["pitch"])
        duration = float(speech.get("duration") or 2)
        with LOCK:
            STATE.update(audio_url=speech.get("url", ""), audio_duration=duration,
                         audio_id=STATE["audio_id"] + 1, audio_pending=False,
                         status="speaking")
        if speech.get("error"):
            add_event("error", f"语音合成失败（字幕照常）：{speech['error'][:80]}")
        time.sleep(min(20.0, duration + 0.6))
        with LOCK:
            STATE["status"] = "idle"
            STATE["last_activity"] = time.time()
        _idle_step += 1
    except Exception as exc:
        add_event("error", f"自主发言失败：{str(exc)[:120]}")
    finally:
        _idle_busy = False


def play_song(item: dict | None, cfg: dict | None = None) -> dict | None:
    """把一首歌推给舞台；item 为空表示停播。"""
    cfg = cfg or config.load()
    with LOCK:
        mid = STATE["music"]["id"] + 1
        if not item:
            STATE["music"].update(playing=False, id=mid, title="", url="", user="", gift="",
                                  duration=0, seq=0)
            return None
        STATE["music"].update(
            id=mid,
            playing=True,
            title=item["title"],
            url=item["url"],
            user=item["user"],
            gift=item.get("gift", ""),
            duration=item["duration"],
            seq=item["seq"],
            volume=float(cfg["songs"].get("volume", 0.55)),
        )
    add_event("music", f"♪ 《{item['title']}》· 点歌人 {item['user']}")
    threading.Thread(target=_music_watch, args=(mid, float(item["duration"]) + 4), daemon=True).start()
    return item


def _music_watch(mid: int, seconds: float) -> None:
    """客户端没回报结束时的兜底推进，防止音乐卡死。"""
    time.sleep(max(3.0, seconds))
    with LOCK:
        if STATE["music"]["id"] != mid or not STATE["music"]["playing"]:
            return
    advance_music()


def advance_music() -> dict | None:
    cfg = config.load()
    if not cfg["songs"].get("auto_next", True):
        with LOCK:
            STATE["music"].update(playing=False, id=STATE["music"]["id"] + 1,
                                  title="", url="", user="", gift="", duration=0, seq=0)
        songs.JUKEBOX.current = None
        return None
    nxt = songs.JUKEBOX.finish()
    if nxt is None:
        # 队列空了：自动补一首抖音热歌，别让直播间安静下来
        auto_dj_start(cfg, reason="续播")
        return None
    return play_song(nxt, cfg)


def song_status() -> dict:
    cfg = config.load()
    st = songs.JUKEBOX.status()
    online = music.status(cfg)
    st.update({
        "enabled": bool(cfg["songs"].get("enable", True)),
        "volume": float(cfg["songs"].get("volume", 0.55)),
        "gift_min_value": float(cfg["songs"].get("gift_min_value", 0.5)),
        "auto_next": bool(cfg["songs"].get("auto_next", True)),
        "auto_dj": bool(cfg["songs"].get("auto_dj", True)),
        "auto_dj_keep": bool(cfg["songs"].get("auto_dj_keep", True)),
        "auto_dj_last": _DJ["last"],
        "online": online,
        "online_enabled": online["online"],
        "source": online["source"],
        "sources": online["sources"],
        "library": songs.scan(),
    })
    return st


def publish_action(action: dict, user: str, gift: str, count: int = 1,
                   value: float = 0.0, text: str = "") -> None:
    """把「送礼物 → 做动作」推给舞台（舞台看 id 变化播放对应特效）。

    action 里的 gif / hold 都来自 gift_actions.resolve()，即 settings.json 的
    gift_actions.actions 覆盖 + 单条规则，用户改配置就立刻生效，不用重启。
    """
    if not action:
        return
    with LOCK:
        ACTION_SEQ["id"] += 1
        STATE["action"] = {
            "id": ACTION_SEQ["id"],
            "name": action.get("action") or "bow",
            "fx": action.get("fx") or "sparkle",
            "gif": action.get("gif") or "",
            "hold": float(action.get("hold") or gift_actions.DEFAULT_HOLD),
            "text": text[:60],
            "user": user,
            "gift": gift,
            "count": int(count or 1),
            "value": round(float(value or 0), 1),
            "at": time.time(),
        }
    add_event("action", f"动作 {STATE['action']['name']}：{user} 的 {gift}")


GIFT_NOTICE_AT: dict[str, float] = {}


def gift_notice_ok(user: str, cfg: dict) -> bool:
    """礼物答谢的轻节流：连击已经聚合过，这里只防不同礼物连环刷屏。"""
    now = time.time()
    gap = float(cfg["douyin"].get("gift_gap", 0.8))
    user_gap = float(cfg["douyin"].get("gift_user_gap", 2.0))
    with LOCK:
        if now - GIFT_NOTICE_AT.get("__all__", 0) < gap:
            return False
        if now - GIFT_NOTICE_AT.get(user, 0) < user_gap:
            return False
        GIFT_NOTICE_AT["__all__"] = now
        GIFT_NOTICE_AT[user] = now
        if len(GIFT_NOTICE_AT) > 400:
            for name, ts in list(GIFT_NOTICE_AT.items()):
                if now - ts > 1800 and name != "__all__":
                    GIFT_NOTICE_AT.pop(name, None)
    return True


def maybe_gift_song(user: str, gift: str, gift_value: float, result: dict, cfg: dict) -> bool:
    """礼物达到门槛就自动点一首歌；返回是否需要在本轮回复后开始播放。

    在线曲库开着的时候走后台线程：先答谢、再点歌——网络慢也不会把直播间卡住。
    """
    if not cfg["songs"].get("enable", True):
        return False
    if gift_value < float(cfg["songs"].get("gift_min_value", 0.5)):
        return False
    max_queue = int(cfg["songs"].get("max_queue", 10))
    online = bool(cfg["songs"].get("online", True)) and bool(cfg["songs"].get("gift_song_hot", True))

    if online:
        def bg() -> None:
            try:
                query = ""
                hot = []
                try:
                    hot = music.hot_douyin(cfg, limit=6, budget=4.0)
                except Exception:
                    hot = []
                if hot:
                    pick = random.choice(hot)
                    query = f"{pick['name']} {pick['artist']}"
                r = songs.JUKEBOX.request(user, query, gift=gift, priority=2,
                                          max_queue=max_queue, cfg=cfg)
                if not r.get("ok"):
                    add_event("skip", f"礼物点歌没排上：{r.get('reason') or '未知'}", user)
                    return
                add_event("music", f"礼物点歌：《{r['song']['title']}》· {user} 的 {gift}")
                with LOCK:
                    playing = STATE["music"]["playing"]
                if not playing:
                    play_song(songs.JUKEBOX.start_next(), config.load())
            except Exception as exc:
                add_event("error", f"礼物点歌失败：{str(exc)[:100]}")

        threading.Thread(target=bg, daemon=True).start()
        result["reply"] = ((result.get("reply") or "") + " 顺手给你点首歌，马上放。").strip()[:150]
        return False

    r = songs.JUKEBOX.request(user, "", gift=gift, priority=2,
                              max_queue=max_queue, cfg=cfg)
    if not r.get("ok"):
        if r.get("reason") == "full":
            result["reply"] = (result.get("reply") or "") + " 点歌台排满了，等这首放完再点哦。"
        return False
    item = r["song"]
    base = (result.get("reply") or "").strip()
    tail = f"对了，《{item['title']}》给你点上了，礼物点歌，工位音响归你。"
    reply = (base + " " + tail).strip() if base else tail
    result["reply"] = reply[:150]
    # 点歌只是顺带的一句话，别把礼物动作的动图（大哭 / 做饭 / 敲代码 / 躺沙发）顶掉
    result.setdefault("emotion", "happy")
    result.setdefault("gif", brain.EMOTIONS["happy"])
    return True


def song_request_reply(user: str, query: str, cfg: dict) -> tuple[dict, bool]:
    now = time.time()
    cooldown = float(cfg["songs"].get("free_request_cooldown", 15))
    last = FREE_SONG_AT.get(user, 0)
    base = {"provider": "点歌台", "usage": {"prompt_tokens": 0, "completion_tokens": 0},
            "facts_used": [], "new_facts": []}
    if now - last < cooldown:
        wait = int(cooldown - (now - last)) + 1
        return ({**base, "reply": f"点歌别急呀{user}，{wait} 秒后再点，我先把这首放完。",
                 "emotion": "mischievous", "gif": brain.EMOTIONS["mischievous"]}, False)
    r = songs.JUKEBOX.request(user, query, priority=1,
                              max_queue=int(cfg["songs"].get("max_queue", 10)), cfg=cfg)
    if not r.get("ok"):
        msg = ("点歌台排满了，等这首放完再点吧。" if r.get("reason") == "full"
               else "曲库还空着，先往 songs/ 里放几首吧。")
        return ({**base, "reply": msg, "emotion": "calm", "gif": brain.EMOTIONS["calm"]}, False)
    FREE_SONG_AT[user] = now
    item = r["song"]
    if r.get("matched") and r.get("online"):
        reply = f"找到了！{item.get('artist') or ''}的《{item['title']}》，马上放给你听。"
    elif r.get("matched"):
        reply = f"收到{user}的点歌，《{item['title']}》安排上！"
    else:
        why = r.get("note") or "这首我还没学会"
        reply = f"《{query or '随便来一首'}》{why}，先给你放一首《{item['title']}》，一样好听。"
    if r.get("position", 1) > 1:
        reply += f" 前面还有 {r['position'] - 1} 首，稍等一下。"
    return ({**base, "reply": reply, "emotion": "happy", "gif": brain.EMOTIONS["happy"]}, True)


# 事件优先级：弹幕、礼物永远排最前；进场欢迎垫底（有人说话就让位）
# 数字越小越先处理；同类按到达顺序
PRIORITY = {
    "gift": 0,      # 送礼 = 真金白银，永远第一个答谢
    "comment": 1,   # 弹幕 = 直播的主体
    "follow": 2,    # 关注
    "like": 3,      # 点赞：批量刷，随时可让位
    "enter": 4,     # 进场欢迎：垫底，队里有弹幕/礼物就直接让位
    "promo": 5,     # 定时口播：最不着急，队列里有人说话就不插
}
ENTER_STALE_SECONDS = 15.0     # 进场欢迎排队超过这么久就过期（人早进来了，别再喊）
_PENDING: dict[str, int] = {}
GIFT_AUDIT = config.DATA_DIR / "gift-events.log"   # 「礼物到底有没有到」的流水


def _log_gift_event(user: str, gift: str, count: int, value: float, event_id: str = "") -> None:
    """每收到一条礼物就记一行，事后能确认是「没收到」还是「收到没回」。"""
    try:
        if GIFT_AUDIT.exists() and GIFT_AUDIT.stat().st_size > 256 * 1024:
            GIFT_AUDIT.replace(GIFT_AUDIT.with_suffix(".log.1"))
        GIFT_AUDIT.parent.mkdir(parents=True, exist_ok=True)
        with open(GIFT_AUDIT, "a", encoding="utf-8") as fh:
            fh.write(f"{datetime.now():%Y-%m-%d %H:%M:%S}\t{user}\t{gift}\t×{count}\t"
                     f"¥{value:.1f}\t{event_id}\n")
    except OSError:
        pass


def _pending_high() -> int:
    """还有多少条弹幕/礼物在排队（不含正在处理的那条）。"""
    with LOCK:
        return _PENDING.get("comment", 0) + _PENDING.get("gift", 0)


# ---------------------------------------------------------------- 事件入队

def enqueue(event: dict, source: str = "manual") -> bool:
    global _seq
    event_id = str(event.get("event_id") or "")
    if event_id:
        with LOCK:
            if event_id in SEEN_SET:
                return False
            SEEN.append(event_id)
            SEEN_SET.add(event_id)
            if len(SEEN) == SEEN.maxlen:
                SEEN_SET.intersection_update(SEEN)
    kind = event.get("kind", "comment")
    backlog = QUEUE.qsize()
    if kind == "comment" and backlog >= 8:
        add_event("skip", f"{event.get('username', '观众')}：{str(event.get('text', ''))[:30]}（队列积压，已跳过）")
        return False
    # 进场/点赞最容易刷屏：队列一有积压就只记弹幕池、不占播报时间，
    # 否则一堆「欢迎」会把真正的弹幕挤掉
    if kind in ("enter", "like") and backlog >= 2:
        who = event.get("username", "观众")
        add_event(kind, f"{who} {'游进了直播间' if kind == 'enter' else '点了个赞'}")
        return False
    priority = PRIORITY.get(kind, 3)
    event["_queued_at"] = time.time()
    with LOCK:
        _seq += 1
        seq = _seq
        _PENDING[kind] = _PENDING.get(kind, 0) + 1
    QUEUE.put((priority, seq, event))
    ensure_worker()
    return True


def ensure_worker() -> None:
    global _worker_started
    if _worker_started:
        return
    with LOCK:
        if _worker_started:
            return
        _worker_started = True
    threading.Thread(target=worker_loop, daemon=True).start()


# ---------------------------------------------------------------- 工作线程

def worker_loop() -> None:
    while True:
        try:
            _, _, event = QUEUE.get(timeout=1.0)
        except queue.Empty:
            promo_tick()         # 到点就插一句「点点赞、点点关注」
            idle_tick()          # 没人说话就自己找话题
            continue
        kind = str(event.get("kind") or "comment")
        with LOCK:
            if _PENDING.get(kind, 0) > 0:
                _PENDING[kind] -= 1
        try:
            handle_event(event)
        except Exception as exc:  # 单条失败不影响直播
            add_event("error", f"处理失败：{str(exc)[:120]}")
        finally:
            QUEUE.task_done()
            with LOCK:
                STATE["queue"] = QUEUE.qsize()


def handle_event(event: dict) -> None:
    global _idle_step
    cfg = config.load()
    kind = event.get("kind", "comment")
    if kind != "promo":
        _idle_step = 0           # 有人互动，冷场间隔重新从基础值算起（口播不算互动）
    user = str(event.get("username") or event.get("user") or "路人")[:40]
    text = str(event.get("text") or "").strip()

    # 原始入站流水（外部插件读它来驱动直播宠物）；异常一律吞掉，绝不影响直播
    if kind in AUDIENCE_KINDS:
        try:
            add_inbound(kind, user, text or str(event.get("gift") or ""))
        except Exception:
            pass

    # 抖音连上的一瞬间会把历史弹幕一起推下来：太旧的直接丢，不占队列也不回
    ts = event.get("ts") or 0
    if kind == "comment" and ts:
        try:
            age = time.time() - float(ts) / 1000.0 if float(ts) > 1e11 else time.time() - float(ts)
        except (TypeError, ValueError):
            age = 0
        if age > 75:
            add_event("system", f"忽略历史弹幕（{int(age)} 秒前）：{user}：{text[:20]}", user)
            return

    gift_value = 0.0
    song_pending = False
    # 优先级：有人在说话/送礼就先服务他们，进场欢迎和点赞答谢直接让位
    if kind in ("enter", "like"):
        high = _pending_high()
        if high > 0:
            memory.upsert_user(user)
            add_event("skip", f"{user} 的{'进场欢迎' if kind == 'enter' else '点赞答谢'}"
                              f"让位（还有 {high} 条弹幕/礼物在排队）", user)
            return
        waited = time.time() - float(event.get("_queued_at") or time.time())
        stale = float(cfg["douyin"].get("enter_stale_seconds", ENTER_STALE_SECONDS))
        if kind == "enter" and waited > stale:
            memory.upsert_user(user)
            add_event("skip", f"{user} 的进场欢迎已过期（排了 {int(waited)} 秒，人早进来了）", user)
            return
    if kind == "enter":
        memory.upsert_user(user)
        add_event("enter", f"{user} 游进了直播间", user)
        with LOCK:
            STATE.update(username=user, comment="游进了直播间")
        if not notice_ok("enter", user):
            return
        result = brain.welcome_reply(user, "enter", cfg)
    elif kind == "like":
        memory.upsert_user(user)
        add_event("like", f"{user} 点了个赞", user)
        with LOCK:
            STATE.update(username=user, comment="点了个赞")
        if not notice_ok("like", user):
            return
        result = brain.welcome_reply(user, "like", cfg)
    elif kind == "gift":
        gift = str(event.get("gift") or "礼物")[:40]
        count = max(1, int(event.get("count") or 1))
        # 有 diamond 就按 10 抖币=1 元 算，没有才用价目表兜底
        diamond = int(event.get("diamond") or 0)
        if diamond:
            gift_value = round(diamond * count / 10.0, 1)
        else:
            gift_value = round(GIFT_VALUES.get(gift, 0.1) * count, 1)
        try:
            if event.get("value") is not None:
                gift_value = max(gift_value, float(event["value"]))
        except (TypeError, ValueError):
            pass

        # ---- 礼物 → 动作（可配置：小星星转圈、吃饭开饭……）----
        action = gift_actions.resolve(gift, gift_value, cfg)
        action_line = gift_actions.line_for(action, user, gift, count, gift_value) if action else ""
        publish_action(action, user, gift, count, gift_value, action_line)

        total_text = f"{gift}×{count}" if count > 1 else gift
        with LOCK:
            STATE["gifts"] += 1
            STATE["gift_value"] = round(STATE["gift_value"] + gift_value, 1)
            STATE["last_gift"] = f"{user} · {total_text}" + (f" · ¥{gift_value:.1f}" if gift_value else "")
        add_event("gift", f"{user} 送出 {total_text}"
                  + (f"（¥{gift_value:.1f}）" if gift_value else ""), user)
        _log_gift_event(user, gift, count, gift_value, str(event.get("event_id") or ""))
        with LOCK:
            STATE.update(username=user, comment=f"送出 {total_text}")
        memory.upsert_user(user, gift_value)
        memory.add_turn(user, "user", f"[礼物] {total_text}")

        # 答谢语音做个轻节流：动作照放，话别连成机关枪
        if not gift_notice_ok(user, cfg):
            add_event("skip", f"{user} 的 {total_text}（答谢节流，动作照放）", user)
            return
        result = brain.gift_reply(user, gift, count, cfg, value=gift_value, action=action,
                                  stats=live_stats())
        song_pending = maybe_gift_song(user, gift, gift_value, result, cfg)
    elif kind == "follow":
        memory.upsert_user(user)
        add_event("follow", f"{user} 关注了直播间", user)
        result = brain.welcome_reply(user, "follow", cfg)
    elif kind == "promo":
        # 定时口播：点赞 / 关注 / 小心心
        user = cfg["host"]["name"]
        with LOCK:
            STATE.update(username=user, comment="口播：点点赞、点点关注、点点小心心")
        result = brain.promo_reply(cfg, avoid=list(_promo_history), stats=live_stats())
        text = result["reply"]
        _promo_history.append(text)
        del _promo_history[:-8]
        add_event("promo", f"📣 {text}", user)
    else:
        if not text:
            return
        if not allow_reply(user, cfg):
            add_event("skip", f"{user}：{text}（触发限流，已跳过）", user)
            return
        memory.upsert_user(user)
        memory.add_turn(user, "user", text)
        add_event("comment", f"{user}：{text}", user)
        with LOCK:
            STATE.update(username=user, comment=text, status="thinking", facts_used=[], new_facts=[])
        song_cmd = songs.parse_command(text) if cfg["songs"].get("enable", True) else None
        if song_cmd is not None:
            result, song_pending = song_request_reply(user, song_cmd, cfg)
        else:
            result = brain.respond(user, text, cfg, stats=live_stats())

    # 所有回复（弹幕 / 礼物答谢 / 进场）都算一次互动，token 也统一累加，
    # 这样舞台上的「TOKEN」才是这场直播真实烧掉的量
    usage = result.get("usage") or {}
    with LOCK:
        STATE["requests"] += 1
        STATE["input_tokens"] += int(usage.get("prompt_tokens") or 0)
        STATE["output_tokens"] += int(usage.get("completion_tokens") or 0)

    reply = result["reply"]
    memory.add_turn(user, "host", reply, result["emotion"])
    if kind == "comment":
        memory.add_highlight(user, f"{user}问：{text[:40]}")
    used_tool = result.get("tool")
    if used_tool and used_tool.get("text"):
        add_event("tool", f"🔧 {used_tool['name']}：{used_tool['text']}", user)

    with LOCK:
        STATE.update(
            reply=reply,
            username=user if kind in ("comment", "gift", "promo") else STATE["username"],
            emotion=result["emotion"],
            # 礼物动作自带动图（大哭 / 做饭 / 敲代码 / 躺沙发），没有才按情绪回退
            gif=result.get("gif") or pick_gif(result["emotion"]),
            provider=result["provider"],
            facts_used=result.get("facts_used", []),
            new_facts=result.get("new_facts", []),
            audio_pending=True,
            status="thinking",
            last_activity=time.time(),
        )
    add_event("reply", reply)

    speech = tts.synth(reply, cfg["voice"], cfg["rate"], cfg["pitch"])
    duration = float(speech.get("duration") or 2)
    with LOCK:
        if speech.get("url"):
            STATE.update(audio_url=speech["url"], audio_duration=duration,
                         audio_id=STATE["audio_id"] + 1, audio_pending=False, status="speaking")
        else:
            STATE.update(audio_url="", audio_duration=duration,
                         audio_pending=False, status="speaking")
    if speech.get("error"):
        add_event("error", f"语音合成失败（字幕照常）：{speech['error'][:80]}")
    time.sleep(min(20.0, duration + 0.6))
    with LOCK:
        STATE["status"] = "idle"
        STATE["last_activity"] = time.time()
        music_playing = STATE["music"]["playing"]
    if song_pending and not music_playing:
        play_song(songs.JUKEBOX.start_next(), config.load())


def live_stats() -> dict:
    """本场战报：给智能体注入、也给「stats」工具查询。"""
    st = memory.stats()
    cfg = config.load()
    with LOCK:
        try:
            uptime = int(time.time() - datetime.fromisoformat(STATE["started_at"]).timestamp())
        except (TypeError, ValueError):
            uptime = 0
        tin = int(STATE["input_tokens"])
        tout = int(STATE["output_tokens"])
        data = {
            "requests": int(STATE["requests"]),
            "gifts": int(STATE["gifts"]),
            "gift_value": round(float(STATE["gift_value"]), 1),
            "last_gift": STATE["last_gift"],
            "input_tokens": tin,
            "output_tokens": tout,
            "tokens": tin + tout,
            "uptime": max(0, uptime),
            "queue": QUEUE.qsize(),
            "music": STATE["music"].get("title") or "",
            "price_per_million": float(cfg.get("token_price") or 2.0),
        }
    data["facts"] = int(st.get("facts") or 0)
    data["users"] = int(st.get("users") or 0)
    return data


tools.set_stats_provider(live_stats)


def notice_ok(kind: str, user: str) -> bool:
    """进场欢迎 / 点赞答谢 的节流：全局间隔 + 同一观众冷却，避免刷屏。"""
    cfg = config.load()
    if kind == "enter" and not cfg["douyin"].get("welcome_enter", True):
        return False
    if kind == "like" and not cfg["douyin"].get("welcome_like", True):
        return False
    now = time.time()
    gap = float(cfg["douyin"].get(f"{kind}_gap", 5.0))
    user_gap = float(cfg["douyin"].get(f"{kind}_user_gap", 180.0))
    with LOCK:
        if now - NOTICE_AT.get(kind, 0) < gap:
            return False
        seen = NOTICE_USER.setdefault(kind, {})
        if now - seen.get(user, 0) < user_gap:
            return False
        NOTICE_AT[kind] = now
        seen[user] = now
        if len(seen) > 400:  # 只留最近半小时，防止越跑越大
            for name, ts in list(seen.items()):
                if now - ts > 1800:
                    seen.pop(name, None)
        return True


def allow_reply(user: str, cfg: dict) -> bool:
    now = time.time()
    cooldown = float(cfg["douyin"].get("auto_reply_cooldown", 1.2))
    per_min = int(cfg["douyin"].get("max_reply_per_minute", 20))
    with LOCK:
        last = LAST_REPLY_AT.get(user, 0)
        if now - last < cooldown:
            return False
        while REPLY_TIMES and now - REPLY_TIMES[0] > 60:
            REPLY_TIMES.popleft()
        if len(REPLY_TIMES) >= per_min:
            return False
        LAST_REPLY_AT[user] = now
        REPLY_TIMES.append(now)
    return True


# ---------------------------------------------------------------- 抖音来源回调

_MATE: "mate_log.MateLogWatcher | None" = None


def on_douyin_event(event: dict) -> None:
    # 顺手攒 userId → 昵称：直播伴侣的礼物日志只有 userId，昵称得从这里来
    uid = str(event.get("user_id") or "")
    who = str(event.get("username") or "")
    if uid and who and who != "观众":
        names.remember(uid, who)
    enqueue(event, source="douyin")


def on_douyin_log(text: str) -> None:
    add_event("douyin", text)


def start_mate_watcher() -> None:
    """挂上直播伴侣日志桥：网页 WS 拿不到礼物，就从主播端日志里捞。"""
    global _MATE
    stop_mate_watcher()
    try:
        watcher = mate_log.MateLogWatcher(on_douyin_event, cfg_getter=config.load,
                                          log=on_douyin_log)
        watcher.start()
        _MATE = watcher
        where = watcher._log_dir()
        add_event("system", f"礼物日志桥已挂上：{where}" if where.exists()
                  else f"礼物日志桥待命（没找到直播伴侣日志目录 {where}）")
    except Exception as exc:
        add_event("error", f"礼物日志桥启动失败：{str(exc)[:100]}")


def stop_mate_watcher() -> None:
    global _MATE
    if _MATE is None:
        return
    try:
        _MATE.stop()
    except Exception:
        pass
    _MATE = None


def start_douyin(mode: str, url: str) -> dict:
    global _MATE
    cfg = config.load()
    dcfg = cfg.get("douyin") or {}
    stop_mate_watcher()
    st = douyin.start(mode, url, on_douyin_event, on_douyin_log,
                      cookie=str(dcfg.get("cookie") or ""),
                      identity=str(dcfg.get("identity") or "audience"),
                      api_version=str(dcfg.get("api_version") or "v2"),
                      did=str(dcfg.get("did") or ""),
                      ws_host=str(dcfg.get("ws_host") or ""))
    if mode == "live" and dcfg.get("mate_log", True):
        start_mate_watcher()
    detail = f" → {url}" if mode in ("bridge", "live") and url else ""
    add_event("system", f"抖音数据源：{mode}{detail}")
    if st.get("state") == "error" and st.get("last_error"):
        add_event("error", f"数据源启动失败：{st['last_error']}")
    return st


# ---------------------------------------------------------------- HTTP

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".png": "image/png",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
    ".json": "application/json; charset=utf-8",
    ".ico": "image/x-icon",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "FatWhaleLive/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # 安静一点，只留关键日志
        try:
            first = str(args[0]) if args else ""
        except Exception:
            first = ""
        if "/api/state" in first or "/stage" in first:
            return
        if sys.stdout:                  # 打包成 exe 后没有控制台，stdout 是 None
            try:
                line = fmt % args
            except Exception:           # 参数不是字符串（如 HTTPStatus）时别把请求线程搞崩
                line = f"{fmt} {args}"
            sys.stdout.write(f"[{self.log_date_time_string()}] {line}\n")

    # ---------- 基础响应 ----------
    def _send(self, code: int, body: bytes, ctype: str, cache: str = "no-store") -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def json(self, data, code: int = 200) -> None:
        self._send(code, json.dumps(data, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8")

    def body_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return {}

    def serve_file(self, path: Path, root: Path, cache: str = "no-store") -> None:
        try:
            resolved = path.resolve()
            if root.resolve() not in resolved.parents and resolved != root.resolve():
                return self.json({"error": "forbidden"}, 403)
            if not resolved.is_file():
                return self.json({"error": "not found", "path": str(path)}, 404)
            data = resolved.read_bytes()
            ctype = CONTENT_TYPES.get(resolved.suffix.lower(), "application/octet-stream")
            rng = self.headers.get("Range") or ""
            m = re.match(r"bytes=(\d*)-(\d*)$", rng.strip())
            if m and (m.group(1) or m.group(2)):
                start = int(m.group(1) or 0)
                end = int(m.group(2)) if m.group(2) else len(data) - 1
                end = min(end, len(data) - 1)
                if start > end or start >= len(data):
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{len(data)}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                chunk = data[start:end + 1]
                self.send_response(206)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Range", f"bytes {start}-{end}/{len(data)}")
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Content-Length", str(len(chunk)))
                self.send_header("Cache-Control", cache)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(chunk)
                return
            self._send(200, data, ctype, cache)
        except OSError as exc:
            self.json({"error": str(exc)}, 500)

    # ---------- GET ----------
    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)

        if path == "/api/state":
            return self.json(snapshot())
        if path == "/api/feed":
            # 增量读原始入站事件：?since=<id>&limit=<n>。首连可先读 last 再定 since。
            # claim=1：独占读取，读走的行不再给第二个消费者（防止多个插件实例各处理一遍）。
            try:
                since = int((query.get("since") or ["0"])[0] or 0)
                limit = max(1, min(200, int((query.get("limit") or ["50"])[0] or 50)))
            except (TypeError, ValueError):
                return self.json({"ok": False, "error": "since/limit 必须是整数"}, 400)
            claim = True  # 默认独占读取：一行只交给一个消费者
            with LOCK:
                if claim:
                    since = max(since, INBOUND_CLAIM[0])
                rows = [row for row in INBOUND if int(row["id"]) > since][-limit:]
                if claim and rows:
                    INBOUND_CLAIM[0] = max(INBOUND_CLAIM[0], int(rows[-1]["id"]))
                last = INBOUND_SEQ[0]
            return self.json({"ok": True, "events": rows, "last": last})
        if path == "/api/memory/users":
            limit = int((query.get("limit") or ["24"])[0])
            return self.json({"ok": True, "users": memory.list_users(limit), "stats": memory.stats()})
        if path == "/api/memory/user":
            name = (query.get("name") or [""])[0]
            if not name:
                return self.json({"ok": False, "error": "缺少 name"}, 400)
            data = memory.export_user(name)
            return self.json({"ok": True, **data})
        if path == "/api/douyin/status":
            return self.json({"ok": True, "status": douyin.status()})
        if path == "/api/network":
            refresh = (query.get("refresh") or ["0"])[0] not in ("0", "", "false")
            return self.json({"ok": True, "network": network_status(refresh=refresh)})
        if path == "/api/harness/status":
            cfg = config.load()
            return self.json({"ok": True, "status": harness.status(cfg),
                              "sessions": harness.session_info(cfg)})
        if path == "/api/song/library":
            return self.json({"ok": True, "songs": songs.scan(), "status": song_status()})
        if path == "/api/song/status":
            return self.json({"ok": True, "status": song_status()})
        if path == "/api/music/status":
            cfg = config.load()
            return self.json({"ok": True, "music": music.status(cfg),
                              "catalog": gift_actions.catalog(cfg)})
        if path == "/api/music/search":
            q = (query.get("q") or [""])[0].strip()
            src = (query.get("source") or [""])[0].strip() or None
            limit = int((query.get("limit") or ["6"])[0])
            cfg = config.load()
            hits = music.search(q, cfg, limit=limit, source=src) if q else []
            return self.json({"ok": True, "query": q, "hits": hits})
        if path == "/api/music/hot":
            return self.json({"ok": True, "hits": music.hot_douyin(config.load(), limit=8)})
        if path == "/api/gift/catalog":
            cfg = config.load()
            return self.json({"ok": True, "catalog": gift_actions.catalog(cfg),
                              "rules": gift_actions.rules(cfg),
                              "defaults": gift_actions.DEFAULT_RULES,
                              "gifs": gift_actions.gif_status(GIFS, cfg),
                              "available_gifs": gift_actions.available_gifs(GIFS),
                              "fallback": gift_actions.GIF_FALLBACK,
                              "honorifics": list(gift_actions.HONORIFICS),
                              "default_hold": gift_actions.DEFAULT_HOLD,
                              "max_hold": gift_actions.MAX_HOLD,
                              "settings": cfg.get("gift_actions")})
        if path == "/api/gift/test":
            cfg = config.load()
            gift = (query.get("gift") or ["小星星"])[0]
            value = float((query.get("value") or ["0"])[0] or 0)
            action = gift_actions.resolve(gift, value, cfg)
            return self.json({"ok": True, "gift": gift, "value": value,
                              "action": action,
                              "line": gift_actions.line_for(action, "测试观众", gift, 1, value) if action else ""})
        if path == "/api/gift/action":
            # 只读：查看某个动作当前生效的配置
            name = (query.get("action") or [""])[0].strip()
            cfg = config.load()
            eff = gift_actions.action_config(cfg)
            if name:
                return self.json({"ok": True, "action": dict(eff.get(name) or {}, name=name)})
            return self.json({"ok": True, "actions": eff})
        if path == "/api/gifts/table":
            cfg = config.load()
            q = (query.get("q") or [""])[0].strip()
            rows = gifts.table(cfg)
            if q:
                ql = q.lower()
                rows = [r for r in rows
                        if ql in r["name"].lower() or ql in (r["action_label"] or "").lower()]
            return self.json({"ok": True, "summary": gifts.summary(cfg),
                              "gifts": rows, "query": q})
        if path == "/api/gifs":
            files = sorted(p.name for p in GIFS.glob("*.gif"))
            return self.json({"ok": True, "gifs": files})
        if path == "/healthz":
            return self.json({"ok": True, "time": datetime.now().isoformat(timespec="seconds")})

        if path.startswith("/gifs/"):
            rel = path[len("/gifs/"):]
            return self.serve_file(GIFS / rel, GIFS, cache="public, max-age=3600")
        if path.startswith("/gift-icons/"):
            rel = path[len("/gift-icons/"):]
            root = config.DATA_DIR / "gift-icons"
            return self.serve_file(root / rel, root, cache="public, max-age=3600")
        if path.startswith("/audio/"):
            return self.serve_file(AUDIO / Path(path).name, AUDIO, cache="no-store")
        if path.startswith("/songs/"):
            rel = path[len("/songs/"):]
            return self.serve_file(SONGS / rel, SONGS, cache="public, max-age=600")
        if path.startswith("/music/"):
            rel = path[len("/music/"):]
            return self.serve_file(music.cache_dir() / rel, music.cache_dir(),
                                   cache="public, max-age=3600")

        if path in ("/", "/index.html"):
            return self.serve_file(WEB / "index.html", WEB)
        if path in ("/stage", "/stage.html"):
            return self.serve_file(WEB / "stage.html", WEB)
        return self.serve_file(WEB / path.lstrip("/"), WEB)

    # ---------- POST ----------
    def do_POST(self) -> None:
        path = urlparse(self.path).path
        try:
            if path == "/api/event":
                return self.api_event()
            if path == "/api/config":
                return self.api_config()
            if path == "/api/config/test":
                return self.api_config_test()
            if path == "/api/tts/preview":
                return self.api_tts_preview()
            if path == "/api/tts/test-live":
                return self.api_tts_test_live()
            if path == "/api/tts/settings":
                return self.api_tts_settings()
            if path == "/api/douyin/start":
                return self.api_douyin_start()
            if path == "/api/douyin/stop":
                douyin.stop()
                stop_mate_watcher()
                add_event("system", "抖音数据源已停止")
                return self.json({"ok": True, "status": douyin.status()})
            if path == "/api/network/open":
                return self.api_network_open()
            if path == "/api/memory/forget":
                return self.api_memory_forget()
            if path == "/api/gift/action":
                return self.api_gift_action()
            if path == "/api/gift/action/reset":
                return self.api_gift_action_reset()
            if path == "/api/memory/note":
                data = self.body_json()
                memory.set_note(str(data.get("user", "")), str(data.get("note", "")))
                return self.json({"ok": True})
            if path == "/api/say":
                return self.api_say()
            if path == "/api/song/request":
                return self.api_song_request()
            if path == "/api/music/cache":
                n = music.clear_cache()
                add_event("system", f"音乐搜索缓存已清空（{n} 条），可以重新搜歌了")
                return self.json({"ok": True, "cleared": n})
            if path == "/api/song/skip":
                return self.api_song_skip()
            if path == "/api/song/stop":
                songs.JUKEBOX.stop()
                play_song(None)
                add_event("music", "音乐已停止，点歌队列清空")
                return self.json({"ok": True, "status": song_status()})
            if path == "/api/song/finished":
                return self.api_song_finished()
            if path == "/api/song/retry":
                return self.api_song_retry()
            if path == "/api/tool":
                return self.api_tool()
            if path == "/api/harness/setup":
                return self.api_harness_setup()
            if path == "/api/harness/test":
                return self.api_harness_test()
            if path == "/api/harness/reset":
                harness.reset_sessions()
                brain.reset_agent_state()
                add_event("system", "智能体会话与熔断已重置（下一条弹幕重新认识观众）")
                return self.json({"ok": True, "status": harness.status(config.load()),
                                  "agent": brain.agent_state()})
            return self.json({"error": "not found"}, 404)
        except Exception as exc:
            return self.json({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, 500)

    def api_event(self) -> None:
        data = self.body_json()
        raw_items = data if isinstance(data, list) else [data]
        accepted = 0
        produced = 0
        for item in raw_items:
            for event in douyin.normalize(item) or []:
                produced += 1
                if enqueue(event, source="api"):
                    accepted += 1
        if not produced and raw_items:
            # 允许最简 {kind, username, text}
            event = {
                "kind": data.get("kind", "comment"),
                "username": str(data.get("username", "测试观众"))[:40],
                "text": str(data.get("text", ""))[:300],
                "gift": str(data.get("gift", ""))[:40],
                "count": int(data.get("count", 1) or 1),
                "event_id": str(data.get("event_id", ""))[:80],
            }
            for key in ("diamond", "value", "ts"):
                if data.get(key) not in (None, ""):
                    event[key] = data[key]
            if enqueue(event, source="api"):
                accepted = 1
        return self.json({"ok": accepted > 0, "accepted": accepted, "state": snapshot()})

    def api_config(self) -> None:
        data = self.body_json()
        patch: dict = {}
        for key in ("base_url", "model", "voice", "rate", "pitch", "gif_theme",
                    "reasoning_effort"):
            if key in data and str(data[key]).strip():
                patch[key] = str(data[key]).strip()
        # 人设允许「清空」：空字符串 = 回到内置默认人设（config.DEFAULT_PERSONA）
        if "persona" in data:
            patch["persona"] = str(data.get("persona") or "").strip()
        if data.get("clear_persona"):
            patch["persona"] = ""
        if str(data.get("api_key", "")).strip():
            patch["api_key"] = str(data["api_key"]).strip()
        if data.get("clear_key"):
            patch["api_key"] = ""
        if isinstance(data.get("host"), dict):
            patch["host"] = data["host"]
        if isinstance(data.get("douyin"), dict):
            patch["douyin"] = data["douyin"]
        if isinstance(data.get("memory"), dict):
            patch["memory"] = data["memory"]
        if isinstance(data.get("songs"), dict):
            patch["songs"] = data["songs"]
        if isinstance(data.get("gift_actions"), dict):
            patch["gift_actions"] = data["gift_actions"]
        if isinstance(data.get("idle"), dict):
            patch["idle"] = data["idle"]
        if isinstance(data.get("promo"), dict):
            patch["promo"] = data["promo"]
        if isinstance(data.get("harness"), dict):
            current = dict(config.load().get("harness") or {})
            clean: dict = {}
            for key, value in data["harness"].items():
                if key == "api_key":
                    value = str(value or "").strip()
                    if value:
                        clean["api_key"] = value
                    continue
                if value is None:
                    continue
                if isinstance(value, (list, dict)):
                    clean[key] = value       # quirks / rules 这类结构化字段原样存
                    continue
                clean[key] = value if isinstance(value, (bool, int, float)) else str(value).strip()
            if data.get("clear_harness_key"):
                clean["api_key"] = ""
            if clean.get("enable") is True and not current.get("enable"):
                # 第一次打开：顺手把 profile 铺好，用户不用再点
                merged = {**current, **clean}
                harness.ensure_profile(config.save({"harness": merged}))
            patch["harness"] = clean
        cfg = config.save(patch)
        add_event("system", "配置已保存" + ("（已启用大模型）" if cfg["api_key"] else "（本地话术模式）"))
        return self.json({"ok": True, "settings": config.public(cfg),
                          "harness": harness.status(cfg)})

    def api_config_test(self) -> None:
        cfg = config.load()
        if not cfg["api_key"]:
            return self.json({"ok": False, "error": "请先填写并保存 API Key"}, 400)
        try:
            data = brain.chat_completion(
                [{"role": "system", "content": "只回复四个字：连接成功"},
                 {"role": "user", "content": "测试"}], cfg, max_tokens=20)
            reply = data["choices"][0]["message"]["content"].strip()
            add_event("system", f"模型连接成功：{reply[:40]}")
            return self.json({"ok": True, "message": "连接成功", "reply": reply,
                              "usage": data.get("usage", {})})
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:300]
            return self.json({"ok": False, "error": f"HTTP {exc.code}：{detail}"}, 400)
        except Exception as exc:
            return self.json({"ok": False, "error": str(exc)}, 400)

    def api_tts_preview(self) -> None:
        data = self.body_json()
        cfg = config.save({k: data[k] for k in ("voice", "rate", "pitch") if data.get(k)})
        text = str(data.get("text") or "你好呀，我是大肥鲸，深海工位今天照常加班。")[:160]
        speech = tts.synth(text, cfg["voice"], cfg["rate"], cfg["pitch"])
        return self.json({"ok": bool(speech.get("url")), **speech,
                          "settings": {"voice": cfg["voice"], "rate": cfg["rate"], "pitch": cfg["pitch"]}})

    def api_tts_settings(self) -> None:
        data = self.body_json()
        cfg = config.save({k: data[k] for k in ("voice", "rate", "pitch") if data.get(k)})
        return self.json({"ok": True, "settings": {"voice": cfg["voice"], "rate": cfg["rate"], "pitch": cfg["pitch"]}})

    def api_tts_test_live(self) -> None:
        data = self.body_json()
        cfg = config.save({k: data[k] for k in ("voice", "rate", "pitch") if data.get(k)})
        text = str(data.get("text") or "这是一条 OBS 直播声音测试，听到就说明音频链路正常。")[:160]
        speech = tts.synth(text, cfg["voice"], cfg["rate"], cfg["pitch"])
        if not speech.get("url"):
            return self.json({"ok": False, "error": speech.get("error", "合成失败")}, 400)
        with LOCK:
            STATE.update(audio_url=speech["url"], audio_duration=speech["duration"],
                         audio_id=STATE["audio_id"] + 1, status="speaking")
        add_event("system", "已向 OBS 舞台发送声音测试")
        duration = float(speech["duration"])

        def reset():
            time.sleep(duration + 0.6)
            with LOCK:
                if STATE["status"] == "speaking":
                    STATE["status"] = "idle"

        threading.Thread(target=reset, daemon=True).start()
        return self.json({"ok": True, **speech})

    def api_douyin_start(self) -> None:
        data = self.body_json()
        cfg = config.load()
        mode = str(data.get("mode") or cfg["douyin"].get("mode") or "live")
        if mode == "live":
            url = str(data.get("url") or cfg["douyin"].get("live_url")
                      or cfg["douyin"].get("room_id") or "")
            config.save({"douyin": {"live_url": url}})
        elif mode == "bridge":
            url = str(data.get("url") or cfg["douyin"]["bridge_url"])
        else:
            url = ""
        if data.get("room_id"):
            config.save({"douyin": {"room_id": str(data["room_id"])}})
        if "cookie" in data:
            config.save({"douyin": {"cookie": str(data.get("cookie") or "").strip()}})
        config.save({"douyin": {"mode": mode}})
        st = start_douyin(mode, url)
        if st.get("state") != "error" and auto_dj_start(config.load(), reason="开播"):
            add_event("system", "自动 DJ 已排队：开播先放抖音热歌")
        return self.json({"ok": st.get("state") != "error", "status": st})

    def api_network_open(self) -> None:
        """开放局域网：加防火墙入站规则（非管理员会弹一次 UAC）。"""
        data = self.body_json()
        cfg = config.load()
        port = int((cfg.get("network") or {}).get("port") or PORT)
        elevate = bool(data.get("elevate", True))
        res = add_firewall_rule(port, elevate=elevate)
        if res.get("ok") and res.get("pending"):
            add_event("system", f"已发起防火墙放行（TCP {port}），请在系统弹窗点「是」")
            # 后台等一下再刷新状态，让前端能看到结果
            def wait_and_log():
                for _ in range(6):
                    time.sleep(1.2)
                    st = firewall_status(port)
                    if st.get("exists"):
                        _NET_CACHE["at"] = 0
                        add_event("system", f"局域网已开放：TCP {port} 已放行")
                        return
                add_event("error", f"防火墙规则还没生效，可手动执行：netsh advfirewall firewall add rule "
                                   f'name="{FIREWALL_RULE}" dir=in action=allow protocol=TCP '
                                   f"localport={port} profile=private,domain")
            threading.Thread(target=wait_and_log, daemon=True).start()
        elif res.get("ok"):
            _NET_CACHE["at"] = 0
            add_event("system", res.get("message") or "局域网已开放")
        else:
            add_event("error", f"开放局域网失败：{res.get('error') or '未知'}")
        return self.json({**res, "network": network_status(refresh=True)})

    def api_gift_action(self) -> None:
        """改单个动作的动图 / 停留时长 / 特效，立刻生效（不用重启、不覆盖其它规则）。"""
        data = self.body_json()
        name = str(data.get("action") or "").strip()
        if not name:
            return self.json({"ok": False, "error": "缺少 action"}, 400)
        if name not in gift_actions.ACTION_PRESETS:
            return self.json({"ok": False, "error": f"没有这个动作：{name}"}, 400)
        cfg = config.load()
        patch = gift_actions.set_action_override(
            {"gift_actions": dict(cfg.get("gift_actions") or {})}, name,
            gif=data.get("gif"), fx=data.get("fx"),
            emotion=data.get("emotion"), hold=data.get("hold"))
        if "gif" in data and not str(data.get("gif") or "").strip():
            # 显式清空 = 回到内置默认图
            actions = dict(patch["gift_actions"].get("actions") or {})
            row = dict(actions.get(name) or {})
            row.pop("gif", None)
            if row:
                actions[name] = row
            else:
                actions.pop(name, None)
            patch = {"gift_actions": {"actions": actions}}
        cfg = config.save(patch, replace=("gift_actions.actions",))
        row = (gift_actions.action_config(cfg) or {}).get(name) or {}
        add_event("system", f"动作 {name} 已更新：动图 {row.get('gif') or '默认'}"
                            f" · 停留 {row.get('hold')}s")
        return self.json({"ok": True, "action": dict(row, name=name),
                          "catalog": gift_actions.catalog(cfg),
                          "gifs": gift_actions.gif_status(GIFS, cfg)})

    def api_gift_action_reset(self) -> None:
        """把一个动作（或全部动作）恢复成内置默认。"""
        data = self.body_json()
        name = str(data.get("action") or "").strip()
        cfg = config.load()
        actions = dict((cfg.get("gift_actions") or {}).get("actions") or {})
        if name:
            actions.pop(name, None)
        else:
            actions = {}
        cfg = config.save({"gift_actions": {"actions": actions}},
                          replace=("gift_actions.actions",))
        add_event("system", f"动作 {name or '全部'} 已恢复内置默认")
        return self.json({"ok": True, "catalog": gift_actions.catalog(cfg),
                          "gifs": gift_actions.gif_status(GIFS, cfg)})

    def api_memory_forget(self) -> None:
        data = self.body_json()
        if data.get("fact_id"):
            return self.json({"ok": memory.forget_fact(int(data["fact_id"]))})
        if data.get("user"):
            memory.forget_user(str(data["user"]))
            add_event("system", f"已清空 {data['user']} 的记忆")
            return self.json({"ok": True})
        return self.json({"ok": False, "error": "需要 user 或 fact_id"}, 400)

    def api_song_request(self) -> None:
        data = self.body_json()
        cfg = config.load()
        if not cfg["songs"].get("enable", True):
            return self.json({"ok": False, "error": "点歌功能已关闭"}, 400)
        user = str(data.get("user") or "测试观众")[:40]
        query = str(data.get("query") or "").strip()[:40]
        gift = str(data.get("gift") or "")[:40]
        priority = int(data.get("priority") or (2 if gift else 1))
        r = songs.JUKEBOX.request(user, query, gift=gift, priority=priority,
                                  max_queue=int(cfg["songs"].get("max_queue", 10)), cfg=cfg)
        if not r.get("ok"):
            return self.json({"ok": False, "error": r.get("reason", "入队失败"), **r}, 400)
        note = "" if r.get("matched") else "（没匹配到，随机一首）"
        add_event("music", f"{user} 点歌：《{r['song']['title']}》{note}")
        with LOCK:
            playing = STATE["music"]["playing"]
        if not playing:
            play_song(songs.JUKEBOX.start_next(), cfg)
        return self.json({"ok": True, **r, "status": song_status()})

    def api_song_skip(self) -> None:
        nxt = songs.JUKEBOX.skip()
        play_song(nxt, config.load())
        add_event("music", "已跳过当前歌曲" + (f"，下一首《{nxt['title']}》" if nxt else "，队列已空"))
        return self.json({"ok": True, "next": nxt, "status": song_status()})

    def api_song_finished(self) -> None:
        data = self.body_json()
        mid = int(data.get("id") or 0)
        with LOCK:
            current_id = STATE["music"]["id"]
        if mid and mid != current_id:
            return self.json({"ok": False, "reason": "stale"})
        nxt = advance_music()
        return self.json({"ok": True, "next": nxt, "status": song_status()})

    def api_song_retry(self) -> None:
        """播放出错时换一条链：缓存优先，没缓存就重新取一次（真曲库直链会过期）。"""
        data = self.body_json()
        mid = int(data.get("id") or 0)
        cfg = config.load()
        with LOCK:
            if mid and mid != STATE["music"]["id"]:
                return self.json({"ok": False, "reason": "stale"})
            cur = dict(STATE["music"])
        item = songs.JUKEBOX.current or {}
        if not item:
            return self.json({"ok": False, "reason": "no-current"})
        old = cur.get("url") or ""
        new_url = ""
        if item.get("online"):
            new_url = music.local_url(item)
            if not new_url and cfg["songs"].get("cache_download", True):
                res = music.fetch_to_cache(item, cfg, timeout=25)
                if res.get("ok"):
                    item["url"] = f"/music/{Path(res['path']).name}"
                    new_url = item["url"]
            if not new_url:
                got = music.resolve({"id": item.get("oid"), "source": item.get("source")}, cfg)
                if got.get("ok") and got["url"] != old:
                    item["url"] = got["url"]
                    new_url = got["url"]
        if not new_url:
            new_url = item.get("url") or ""
        changed = bool(new_url and new_url != old)
        if changed:
            with LOCK:
                STATE["music"]["url"] = new_url
            add_event("music", f"《{item.get('title', '')}》换了一条播放链")
        return self.json({"ok": bool(new_url), "url": new_url, "changed": changed,
                          "online": bool(item.get("online"))})

    def api_tool(self) -> None:
        """手动跑一个工具（控制台测试用）。"""
        data = self.body_json()
        name = str(data.get("name") or "weather")
        args = data.get("args") or {}
        if not isinstance(args, dict):
            args = {}
        if data.get("text") and not args.get("city"):
            hit = tools.detect(str(data.get("text")))
            if hit:
                name, args = hit
        cfg = config.load()
        result = tools.run(name, args, cfg.get("tools") or {})
        add_event("tool", f"🔧 {name}：{result.get('text', '')}")
        return self.json({"ok": bool(result.get("ok")), "result": result,
                          "catalog": tools.CATALOG})

    def api_harness_setup(self) -> None:
        """铺 / 刷新直播鲸鱼的 dsh profile（幂等，改完模型或人设再点一次即可）。"""
        cfg = config.load()
        out = harness.ensure_profile(cfg)
        if out.get("ok") and (cfg.get("harness") or {}).get("deep"):
            harness.ensure_profile(cfg, profile=(cfg["harness"].get("deep_profile") or "whale-deep"),
                                   effort="high")
        st = harness.status(cfg)
        add_event("system", "智能体 profile 已就绪：" + (st.get("profile") or "whale")
                  if out.get("ok") else "智能体 profile 失败：" + str(out.get("reason") or ""))
        return self.json({"ok": bool(out.get("ok")), **out, "status": st})

    def api_harness_test(self) -> None:
        """手动让智能体回一句（控制台里的「试一句」）。"""
        data = self.body_json()
        cfg = config.load()
        text = str(data.get("text") or "观众问：鲸鱼为什么会喷水？")[:200]
        res = harness.ask(
            harness.build_prompt("测试观众", text, cfg, {"facts": [], "turns": []}),
            cfg, session_key="console-test", timeout=float(data.get("timeout") or 45),
        )
        st = harness.status(cfg)
        if res.get("ok"):
            speech, facts = harness.split_memory(res.get("reply") or "")
            reply = brain._tidy_agent_reply(speech,
                                           int((cfg.get("harness") or {}).get("max_chars") or 70))
            add_event("system", f"智能体试答（{res.get('elapsed', 0):.1f}s）：{reply[:60]}")
            return self.json({"ok": True, "reply": reply, "facts": facts,
                              "elapsed": round(res.get("elapsed") or 0, 2),
                              "session": res.get("session"), "usage": res.get("usage"), "status": st})
        return self.json({"ok": False, "error": res.get("error") or "智能体没有回话", "status": st}, 200)

    def api_say(self) -> None:
        data = self.body_json()
        text = str(data.get("text") or brain.idle_line(config.load()))[:160]
        cfg = config.load()
        with LOCK:
            STATE.update(reply=text, username="大肥鲸", comment="主播主动开口",
                         provider="主播发言", emotion="calm", gif=pick_gif("calm"),
                         audio_pending=True, status="thinking")
        add_event("reply", text)
        memory.add_turn("大肥鲸", "host", text)

        def run():
            speech = tts.synth(text, cfg["voice"], cfg["rate"], cfg["pitch"])
            duration = float(speech.get("duration") or 2)
            with LOCK:
                STATE.update(audio_url=speech.get("url", ""), audio_duration=duration,
                             audio_id=STATE["audio_id"] + 1, audio_pending=False, status="speaking")
            time.sleep(min(20.0, duration + 0.6))
            with LOCK:
                STATE["status"] = "idle"

        threading.Thread(target=run, daemon=True).start()
        return self.json({"ok": True, "text": text})


# ---------------------------------------------------------------- 启动

def lan_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "127.0.0.1"


VIRTUAL_HINTS = ("vethernet", "wsl", "docker", "default switch", "loopback", "tailscale",
                 "vmware", "virtualbox", "hyper-v", "bluetooth", "蓝牙", "npcap", "tap-")


def adapter_ips() -> list[tuple[str, str]]:
    """(网卡名, IPv4) —— 用 ipconfig 解析，能认出 WSL/Docker/Hyper-V 这些连不上的虚拟网卡。"""
    import subprocess
    try:
        proc = subprocess.run(["ipconfig"], capture_output=True, timeout=8)
        text = (proc.stdout or b"").decode("gbk", errors="replace")
    except (OSError, subprocess.SubprocessError):
        return []
    out: list[tuple[str, str]] = []
    name = ""
    for line in text.splitlines():
        s = line.strip()
        if not s:
            continue
        low = s.lower()
        if s.endswith(":") and ("适配器" in s or "adapter" in low):
            raw = s[:-1]
            for prefix in ("以太网适配器", "无线局域网适配器", "未知适配器", "Tunnel adapter",
                           "Ethernet adapter", "Wireless LAN adapter", "Unknown adapter"):
                raw = raw.replace(prefix, "")
            name = raw.strip() or s[:-1]
        m = re.search(r"IPv4[^:]*:\s*(\d{1,3}(?:\.\d{1,3}){3})", s)
        if m:
            out.append((name or "网卡", m.group(1)))
    return out


def lan_ips() -> list[tuple[str, str]]:
    """可用于局域网访问的 (网卡名, IP)，主网卡排最前。"""
    primary = lan_ip()
    pairs: list[tuple[str, str]] = []
    for name, ip in adapter_ips():
        if ip.startswith(("127.", "169.254.")):
            continue
        if any(h in name.lower() for h in VIRTUAL_HINTS):
            continue
        if ip not in [p[1] for p in pairs]:
            pairs.append((name, ip))
    if not pairs and primary and not primary.startswith("127."):
        pairs = [("默认网卡", primary)]
    pairs.sort(key=lambda p: (p[1] != primary, p[1]))
    return pairs



FIREWALL_RULE = "大肥鲸直播"


def firewall_status(port: int = PORT) -> dict:
    """查有没有放行这个端口的入站规则（netsh 输出是 GBK）。"""
    import subprocess
    try:
        proc = subprocess.run(
            ["netsh", "advfirewall", "firewall", "show", "rule", f"name={FIREWALL_RULE}"],
            capture_output=True, timeout=8,
        )
        text = (proc.stdout or b"").decode("gbk", errors="replace")
        ok = proc.returncode == 0 and ("LocalPort" in text or "本地端口" in text)
        return {"exists": ok, "port": port, "detail": text.strip().splitlines()[:6] if ok else []}
    except (OSError, subprocess.SubprocessError) as exc:
        return {"exists": False, "port": port, "error": str(exc)[:120]}


def add_firewall_rule(port: int = PORT, elevate: bool = False) -> dict:
    """加一条 TCP 入站放行规则。非管理员时需要 UAC 提权。"""
    import subprocess
    args = [
        "advfirewall", "firewall", "add", "rule",
        f"name={FIREWALL_RULE}", "dir=in", "action=allow", "protocol=TCP",
        f"localport={port}", "profile=private,domain",
    ]
    try:
        proc = subprocess.run(["netsh", *args], capture_output=True, timeout=15)
    except (OSError, subprocess.SubprocessError) as exc:
        return {"ok": False, "error": str(exc)[:160]}
    if proc.returncode == 0:
        return {"ok": True, "message": f"已放行 TCP {port}（专用/域网络）"}
    detail = (proc.stdout or b"") .decode("gbk", errors="replace") + \
             (proc.stderr or b"").decode("gbk", errors="replace")
    if elevate:
        # 弹一次 UAC：让用户点「是」，规则就加上了
        arg_line = " ".join(args)
        script = ("Start-Process -Verb RunAs -WindowStyle Hidden -FilePath netsh "
                  f"-ArgumentList '{arg_line}'")
        try:
            subprocess.Popen(
                ["powershell", "-NoProfile", "-WindowStyle", "Hidden", "-Command", script],
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                close_fds=True,
            )
            return {"ok": True, "pending": True,
                    "message": "已弹出管理员确认框，点「是」即可放行（约 2 秒后生效）"}
        except OSError as exc:
            return {"ok": False, "error": f"提权失败：{exc}", "detail": detail.strip()[:300]}
    return {
        "ok": False,
        "error": "需要管理员权限",
        "detail": detail.strip()[:300],
        "command": f'netsh advfirewall firewall add rule name="{FIREWALL_RULE}" '
                   f"dir=in action=allow protocol=TCP localport={port} profile=private,domain",
    }


_NET_CACHE: dict = {"at": 0.0, "port": 0, "value": {}}


def network_status(refresh: bool = False) -> dict:
    cfg = config.load()
    net = cfg.get("network") or {}
    port = int(net.get("port") or PORT)
    host = str(net.get("host") or HOST)
    now = time.time()
    # 轮询里也会调，gethostname/netsh 都别每次都跑
    if (not refresh and _NET_CACHE["value"] and _NET_CACHE["port"] == port
            and now - _NET_CACHE["at"] < 30):
        return dict(_NET_CACHE["value"])
    ips = lan_ips()
    fw = firewall_status(port)
    value = {
        "host": host,
        "port": port,
        "allow_lan": bool(net.get("allow_lan", True)),
        "ips": [ip for _, ip in ips],
        "adapters": [{"name": name, "ip": ip,
                      "url": f"http://{ip}:{port}/",
                      "stage": f"http://{ip}:{port}/stage"} for name, ip in ips],
        "lan_urls": [f"http://{ip}:{port}/" for _, ip in ips],
        "stage_urls": [f"http://{ip}:{port}/stage" for _, ip in ips],
        "local_url": f"http://127.0.0.1:{port}/",
        "local_stage": f"http://127.0.0.1:{port}/stage",
        "firewall": fw,
        "firewall_ok": bool(fw.get("exists")),
        "launch_args": [f"--host={host}", f"--port={port}"],
    }
    _NET_CACHE.update(at=now, port=port, value=value)
    return dict(value)


def boot_checks(autostart: bool = True) -> None:
    add_event("system", "大肥鲸直播服务已启动")
    st = memory.stats()
    add_event("system", f"记忆库已加载：{st['users']} 位观众 / {st['facts']} 条事实 / {st['turns']} 条对话")
    cfg = config.load()
    if cfg["api_key"]:
        add_event("system", f"智能体在线：{cfg['model']} @ {cfg['base_url']}")
    else:
        add_event("system", "未配置 API Key，先用本地话术大脑（记忆照样生效）")
    if (cfg.get("harness") or {}).get("enable"):
        try:
            hres = harness.ensure_profile(cfg)
            hst = harness.status(cfg)
            if hres.get("ok") and hst.get("ok"):
                add_event("system", f"直播智能体已接入：profile {hst['profile']} · "
                                    f"{hst['model']} · 超时 {hst['timeout']}s")
            else:
                add_event("system", "直播智能体未就绪：" + (hres.get("reason") or hst.get("reason") or "未知"))
        except Exception as exc:  # 智能体接不上不影响开播
            add_event("error", f"直播智能体初始化失败：{str(exc)[:100]}")
    dm = cfg["douyin"]
    if autostart and dm.get("mode") in ("live", "bridge"):
        if dm["mode"] == "live" and not dm.get("live_url"):
            add_event("system", "抖音直连未启动：先在控制台「抖音接入」填直播间地址（https://live.douyin.com/房间号）")
        else:
            start_douyin(dm["mode"], dm.get("live_url") if dm["mode"] == "live"
                         else dm.get("bridge_url", "ws://127.0.0.1:8888"))
    # 开播先放抖音热歌（不需要人点），礼物点歌永远排在它前面
    if auto_dj_start(cfg, reason="开播"):
        add_event("system", "自动 DJ 已排队：开播先放抖音热歌")


def make_server(host: str, port: int) -> ThreadingHTTPServer:
    class WhaleServer(ThreadingHTTPServer):
        # Windows 下 allow_reuse_address 会让两个进程同时绑同一端口（请求随机落到旧进程），必须关掉
        allow_reuse_address = False
        daemon_threads = True

        def log_message(self, fmt: str, *args) -> None:      # exe 无控制台，stderr 可能是 None
            if sys.stderr:
                super().log_message(fmt, *args)

        def handle_error(self, request, client_address) -> None:
            import traceback
            from core.paths import LOG_DIR
            try:
                LOG_DIR.mkdir(parents=True, exist_ok=True)
                with open(LOG_DIR / "server-errors.log", "a", encoding="utf-8") as fh:
                    fh.write(f"--- {datetime.now():%Y-%m-%d %H:%M:%S} {client_address}\n")
                    fh.write(traceback.format_exc() + "\n")
            except Exception:
                pass
            if sys.stderr:
                super().handle_error(request, client_address)

    return WhaleServer((host, port), Handler)


def _print_banner(port: int) -> None:
    ip = lan_ip()
    print("\n" + "=" * 62)
    print("  大肥鲸在线直播  ·  Fat Whale Live")
    print("=" * 62)
    print(f"  控制台      http://127.0.0.1:{port}/")
    print(f"  OBS 舞台    http://127.0.0.1:{port}/stage")
    pairs = lan_ips()
    for i, (name, addr) in enumerate(pairs):
        label = "局域网" if i == 0 else "      "
        print(f"  {label}      http://{addr}:{port}/   （{name} · 舞台 /stage）")
    if not pairs:
        print("  局域网      没找到可用网卡，只在本机可访问")
    fw = firewall_status(port)
    if not fw.get("exists"):
        print(f"  ⚠ 防火墙    TCP {port} 还没放行，局域网设备可能连不上：")
        print(f'             netsh advfirewall firewall add rule name="{FIREWALL_RULE}" '
              f"dir=in action=allow protocol=TCP localport={port} profile=private,domain")
        print("             或在控制台点「开放局域网」（会弹管理员确认）")
    print(f"  弹幕回调    POST http://127.0.0.1:{port}/api/event")
    print(f"  记忆库      {memory.DB_PATH}")
    print("=" * 62 + "\n")


def serve(host: str | None = None, port: int | None = None, open_browser: bool = False,
          boot: bool = True) -> None:
    """起服务并阻塞。给 launcher / exe 复用。host/port 为空时用 settings.network。"""
    net = config.load().get("network") or {}
    host = host or str(net.get("host") or HOST)
    port = int(port or net.get("port") or PORT)
    ensure_worker()
    if boot:
        boot_checks(autostart=True)
    server = make_server(host, port)
    _print_banner(port)
    if open_browser:
        threading.Timer(1.2, lambda: webbrowser.open(f"http://127.0.0.1:{port}/")).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n正在关闭…")
    finally:
        douyin.stop()
        try:
            server.shutdown()
        except Exception:
            pass


def main() -> None:
    parser = argparse.ArgumentParser(description="大肥鲸在线直播")
    parser.add_argument("--port", type=int, default=None, help="默认用 settings.json 的 network.port（8790）")
    parser.add_argument("--host", default=None,
                        help="监听地址，默认 0.0.0.0（局域网可访问）；只想本机用填 127.0.0.1")
    parser.add_argument("--open", action="store_true", help="启动后自动打开控制台")
    parser.add_argument("--mode", default="", choices=["", "off", "bridge", "webhook", "live"],
                        help="覆盖抖音数据源模式（live=直连抖音直播间）")
    parser.add_argument("--no-firewall", action="store_true", help="不尝试放行防火墙")
    args = parser.parse_args()

    cfg = config.load()
    net = cfg.get("network") or {}
    port = int(args.port or net.get("port") or PORT)
    host = str(args.host or net.get("host") or HOST)

    ensure_worker()
    boot_checks(autostart=not args.mode)
    if not args.no_firewall and net.get("open_firewall", True):
        fw = firewall_status(port)
        if not fw.get("exists"):
            res = add_firewall_rule(port, elevate=False)
            if res.get("ok"):
                add_event("system", res.get("message") or "防火墙已放行")
            else:
                add_event("system", f"防火墙未放行（{res.get('error')}）：局域网设备可能连不上，"
                                    "控制台点「开放局域网」或手动执行 netsh 命令")
    if args.mode:
        config.save({"douyin": {"mode": args.mode}})
        url = (cfg["douyin"].get("live_url") if args.mode == "live"
               else cfg["douyin"].get("bridge_url", "ws://127.0.0.1:8888"))
        start_douyin(args.mode, url or "")

    try:
        server = make_server(host, port)
    except OSError as exc:
        print(f"\n[启动失败] 端口 {port} 已被占用（{exc}）。")
        print("很可能已经有一个大肥鲸在跑：先在任务管理器结束多余的 python.exe，")
        print(f"或者换个端口：python app.py --port {port + 1}\n")
        raise SystemExit(1)

    _print_banner(port)
    if args.open:
        threading.Timer(1.2, lambda: webbrowser.open(f"http://127.0.0.1:{port}/")).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n正在关闭…")
        douyin.stop()
        server.shutdown()


if __name__ == "__main__":
    main()
