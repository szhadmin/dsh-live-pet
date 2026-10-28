"""userId → 昵称 映射。

抖音网页端消息里 `user.id` 是稳定数字 id，昵称靠进场/弹幕消息带过来。
直播伴侣的礼物日志只有 userId，所以要从我们自己收到的消息里攒一张表，
再回填给礼物事件，这样「谢谢XX的礼物」才叫得出名字。
"""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path

from .paths import DATA_DIR

NAMES_FILE = DATA_DIR / "names.json"
_LOCK = threading.RLock()
_CACHE: dict[str, dict] | None = None
MAX = 3000


def _load() -> dict[str, dict]:
    global _CACHE
    if _CACHE is not None:
        return _CACHE
    try:
        data = json.loads(NAMES_FILE.read_text(encoding="utf-8"))
        _CACHE = data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        _CACHE = {}
    return _CACHE


def _save() -> None:
    data = _load()
    try:
        NAMES_FILE.parent.mkdir(parents=True, exist_ok=True)
        # 控制体积：只留最近 3000 条
        if len(data) > MAX:
            keep = sorted(data.items(), key=lambda kv: kv[1].get("at", 0))[-MAX:]
            data = dict(keep)
            _CACHE = data
        NAMES_FILE.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    except OSError:
        pass


def remember(uid: str, nickname: str) -> None:
    uid = str(uid or "").strip()
    nickname = str(nickname or "").strip()
    if not uid or not nickname or uid == "0":
        return
    with _LOCK:
        data = _load()
        old = data.get(uid)
        if old and old.get("n") == nickname:
            old["at"] = time.time()
            return
        data[uid] = {"n": nickname[:40], "at": time.time()}
        _save()


def nickname_of(uid: str, fallback: str = "") -> str:
    uid = str(uid or "").strip()
    if not uid:
        return fallback
    with _LOCK:
        hit = _load().get(uid)
    if hit and hit.get("n"):
        return hit["n"]
    return fallback or (f"观众{uid[-4:]}" if len(uid) >= 4 else "观众")


def stats() -> dict:
    with _LOCK:
        return {"count": len(_load())}
