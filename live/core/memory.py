"""大肥鲸的记忆库：观众档案、长期事实、对话回合、全场亮点。

纯 SQLite（标准库），进程内单连接 + 线程锁，读写都落盘，重启不丢记忆。
"""
from __future__ import annotations

import json
import re
import sqlite3
import threading
from datetime import datetime, timedelta
from pathlib import Path

from .config import DATA_DIR

DB_PATH = DATA_DIR / "memory.sqlite3"
_LOCK = threading.RLock()
_conn: sqlite3.Connection | None = None

PUNCT = re.compile(r"[\s\u2018-\u201f\u3000-\u303f\uff00-\uffef,.!?;:()\[\]~`@#$%^&*_+=|\\/<>\"'-]+")

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    name TEXT PRIMARY KEY,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    msg_count INTEGER NOT NULL DEFAULT 0,
    gift_value REAL NOT NULL DEFAULT 0,
    affinity REAL NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user TEXT NOT NULL,
    text TEXT NOT NULL,
    norm TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'fact',
    weight REAL NOT NULL DEFAULT 1.0,
    hits INTEGER NOT NULL DEFAULT 0,
    created TEXT NOT NULL,
    last_used TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_user_norm ON facts(user, norm);
CREATE TABLE IF NOT EXISTS turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    emotion TEXT,
    created TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turns_user ON turns(user, id DESC);
CREATE TABLE IF NOT EXISTS highlights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user TEXT,
    text TEXT NOT NULL,
    created TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
"""


def now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def connect() -> sqlite3.Connection:
    global _conn
    with _LOCK:
        if _conn is None:
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            _conn = sqlite3.connect(DB_PATH, check_same_thread=False)
            _conn.row_factory = sqlite3.Row
            _conn.executescript(SCHEMA)
            _conn.commit()
        return _conn


def normalize(text: str) -> str:
    return PUNCT.sub("", text or "").lower()


def tokens(text: str) -> set[str]:
    """中文按字 + 二元组切分，英文数字按词。"""
    t = normalize(text)
    out: set[str] = set()
    for word in re.findall(r"[a-z0-9]{2,}", t):
        out.add(word)
    chinese = re.sub(r"[a-z0-9]", "", t)
    for ch in chinese:
        out.add(ch)
    for i in range(len(chinese) - 1):
        out.add(chinese[i:i + 2])
    return out


def overlap(query: str, text: str) -> float:
    q, t = tokens(query), tokens(text)
    if not q or not t:
        return 0.0
    return len(q & t) / (len(q) ** 0.6 + 1e-9)


# ---------------------------------------------------------------- 用户档案

def upsert_user(name: str, gift_value: float = 0.0) -> None:
    name = (name or "路人").strip()[:40]
    ts = now()
    with _LOCK:
        db = connect()
        row = db.execute("SELECT name FROM users WHERE name=?", (name,)).fetchone()
        if row:
            db.execute(
                "UPDATE users SET last_seen=?, msg_count=msg_count+1, gift_value=gift_value+?, affinity=MIN(100, affinity+0.8) WHERE name=?",
                (ts, gift_value, name),
            )
        else:
            db.execute(
                "INSERT INTO users(name, first_seen, last_seen, msg_count, gift_value, affinity) VALUES(?,?,?,?,?,?)",
                (name, ts, ts, 1, gift_value, 1.0),
            )
        db.commit()


def add_turn(user: str, role: str, content: str, emotion: str | None = None) -> None:
    with _LOCK:
        db = connect()
        db.execute(
            "INSERT INTO turns(user, role, content, emotion, created) VALUES(?,?,?,?,?)",
            ((user or "路人")[:40], role, content[:800], emotion, now()),
        )
        db.commit()


def recent_turns(user: str, limit: int = 6) -> list[dict]:
    with _LOCK:
        db = connect()
        rows = db.execute(
            "SELECT role, content, emotion, created FROM turns WHERE user=? ORDER BY id DESC LIMIT ?",
            ((user or "路人")[:40], int(limit)),
        ).fetchall()
    return [dict(r) for r in reversed(rows)]


# ---------------------------------------------------------------- 长期事实

def add_fact(user: str, text: str, kind: str = "fact", weight: float = 1.0) -> bool:
    text = (text or "").strip()[:160]
    if len(text) < 2:
        return False
    user = (user or "路人")[:40]
    norm = normalize(text)[:120]
    if not norm:
        return False
    with _LOCK:
        db = connect()
        row = db.execute("SELECT id, weight FROM facts WHERE user=? AND norm=?", (user, norm)).fetchone()
        if row:
            db.execute(
                "UPDATE facts SET weight=MIN(5.0, weight+0.3), hits=hits+1, last_used=? WHERE id=?",
                (now(), row["id"]),
            )
            db.commit()
            return False
        db.execute(
            "INSERT INTO facts(user, text, norm, kind, weight, created) VALUES(?,?,?,?,?,?)",
            (user, text, norm, kind, weight, now()),
        )
        db.commit()
        _prune_facts(user)
        return True


def _prune_facts(user: str, limit: int = 60) -> None:
    db = connect()
    total = db.execute("SELECT COUNT(*) c FROM facts WHERE user=?", (user,)).fetchone()["c"]
    if total <= limit:
        return
    db.execute(
        "DELETE FROM facts WHERE id IN (SELECT id FROM facts WHERE user=? ORDER BY weight ASC, hits ASC, id ASC LIMIT ?)",
        (user, total - limit),
    )
    db.commit()


def all_facts(user: str, limit: int = 200) -> list[dict]:
    with _LOCK:
        db = connect()
        rows = db.execute(
            "SELECT id, text, kind, weight, hits, created, last_used FROM facts WHERE user=? ORDER BY weight DESC, id DESC LIMIT ?",
            ((user or "路人")[:40], int(limit)),
        ).fetchall()
    return [dict(r) for r in rows]


def _recency_weight(created: str) -> float:
    try:
        age = datetime.now() - datetime.fromisoformat(created)
    except ValueError:
        return 1.0
    days = max(0.0, age.total_seconds() / 86400)
    return 0.55 + 0.45 * (0.9 ** days)


def search_facts(user: str, query: str, limit: int = 8) -> list[dict]:
    facts = all_facts(user, 200)
    ranked = []
    for f in facts:
        rel = overlap(query, f["text"])
        score = rel * 2.4 + float(f["weight"]) * 0.5 + _recency_weight(f["created"]) * 0.6
        ranked.append((score, rel, f))
    ranked.sort(key=lambda x: (x[0], x[2]["id"]), reverse=True)
    picked = [f for _, rel, f in ranked if rel > 0][:limit]
    if len(picked) < limit:
        for _, rel, f in ranked:
            if f not in picked:
                picked.append(f)
            if len(picked) >= limit:
                break
    if picked:
        with _LOCK:
            db = connect()
            db.executemany("UPDATE facts SET last_used=?, hits=hits+1 WHERE id=?",
                           [(now(), f["id"]) for f in picked])
            db.commit()
    return picked[:limit]


def forget_fact(fact_id: int) -> bool:
    with _LOCK:
        db = connect()
        cur = db.execute("DELETE FROM facts WHERE id=?", (int(fact_id),))
        db.commit()
        return cur.rowcount > 0


def forget_user(user: str) -> None:
    user = (user or "路人")[:40]
    with _LOCK:
        db = connect()
        for table in ("facts", "turns", "users"):
            db.execute(f"DELETE FROM {table} WHERE {'name' if table == 'users' else 'user'}=?", (user,))
        db.execute("DELETE FROM highlights WHERE user=?", (user,))
        db.commit()


# ---------------------------------------------------------------- 全场亮点

def add_highlight(user: str, text: str) -> None:
    text = (text or "").strip()[:200]
    if len(text) < 4:
        return
    with _LOCK:
        db = connect()
        db.execute("INSERT INTO highlights(user, text, created) VALUES(?,?,?)",
                   ((user or "路人")[:40], text, now()))
        db.execute("DELETE FROM highlights WHERE id NOT IN (SELECT id FROM highlights ORDER BY id DESC LIMIT 60)")
        db.commit()


def highlights(limit: int = 4) -> list[dict]:
    with _LOCK:
        db = connect()
        rows = db.execute("SELECT user, text, created FROM highlights ORDER BY id DESC LIMIT ?",
                          (int(limit),)).fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------- 查询/统计

def get_user(name: str) -> dict | None:
    with _LOCK:
        db = connect()
        row = db.execute("SELECT * FROM users WHERE name=?", ((name or "")[:40],)).fetchone()
    return dict(row) if row else None


def list_users(limit: int = 24) -> list[dict]:
    with _LOCK:
        db = connect()
        rows = db.execute(
            "SELECT u.*, (SELECT COUNT(*) FROM facts f WHERE f.user=u.name) AS fact_count "
            "FROM users u ORDER BY u.last_seen DESC LIMIT ?",
            (int(limit),),
        ).fetchall()
    return [dict(r) for r in rows]


def stats() -> dict:
    with _LOCK:
        db = connect()
        one = lambda q: db.execute(q).fetchone()[0]
        return {
            "users": one("SELECT COUNT(*) FROM users"),
            "facts": one("SELECT COUNT(*) FROM facts"),
            "turns": one("SELECT COUNT(*) FROM turns"),
            "highlights": one("SELECT COUNT(*) FROM highlights"),
            "db_path": str(DB_PATH),
        }


def build_context(user: str, query: str, cfg: dict) -> dict:
    """给智能体拼装记忆上下文。"""
    mem = cfg.get("memory", {})
    facts = search_facts(user, query, int(mem.get("fact_limit", 8)))
    turns = recent_turns(user, int(mem.get("short_turns", 6)))
    profile = get_user(user) or {}
    return {
        "user": user,
        "facts": [f["text"] for f in facts],
        "fact_rows": facts,
        "turns": turns,
        "highlights": [h["text"] for h in highlights(int(mem.get("global_highlights", 4)))],
        "profile": profile,
        "is_returning": bool(profile.get("msg_count", 0) > 1),
        "seen_days": _days_since(profile.get("first_seen")),
    }


def _days_since(ts: str | None) -> int:
    if not ts:
        return 0
    try:
        return max(0, (datetime.now() - datetime.fromisoformat(ts)).days)
    except ValueError:
        return 0


def export_user(user: str) -> dict:
    return {
        "profile": get_user(user) or {},
        "facts": all_facts(user),
        "turns": recent_turns(user, 20),
    }


def set_note(user: str, note: str) -> None:
    with _LOCK:
        db = connect()
        db.execute("UPDATE users SET note=? WHERE name=?", ((note or "")[:200], (user or "")[:40]))
        db.commit()
