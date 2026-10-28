"""礼物点歌：本地曲库扫描、模糊匹配、点歌队列与播放调度。

曲库目录 songs/，支持 mp3 / wav / m4a / flac / ogg。
可选 songs/songs.json 写元数据（标题、标签、点歌关键词）：

{
  "songs": [
    {"file": "demo_1.wav", "title": "深海摇篮曲", "tags": ["温柔", "睡前"], "artist": "大肥鲸"},
    {"file": "demo_2.wav", "title": "鲸歌练习曲", "tags": ["轻快"]}
  ]
}
"""
from __future__ import annotations

import json
import random
import re
import threading
import time
import wave
from pathlib import Path

from . import music
from .paths import SONGS_DIR

ROOT = SONGS_DIR.parent
SONG_DIR = SONGS_DIR
SONG_DIR.mkdir(parents=True, exist_ok=True)
SUPPORTED = {".mp3", ".wav", ".m4a", ".flac", ".ogg", ".aac"}
META_FILE = SONG_DIR / "songs.json"

_CACHE: tuple[float, list[dict]] = (0.0, [])
_LOCK = threading.RLock()


# ---------------------------------------------------------------- 工具

def _duration(path: Path) -> float:
    if path.suffix.lower() == ".wav":
        try:
            with wave.open(str(path), "rb") as w:
                return round(w.getnframes() / float(w.getframerate() or 1), 2)
        except (wave.Error, OSError, EOFError):
            pass
    # mp3 ≈ 128kbps；m4a/flac 用体积粗估
    size = path.stat().st_size
    return round(max(3.0, size / 16000.0), 2)


def _meta() -> dict[str, dict]:
    if not META_FILE.exists():
        return {}
    try:
        data = json.loads(META_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    out = {}
    for item in data.get("songs", []) if isinstance(data, dict) else []:
        if isinstance(item, dict) and item.get("file"):
            out[str(item["file"])] = item
    return out


def scan() -> list[dict]:
    """扫描曲库，返回 [{id,title,artist,tags,url,duration}]，结果按 mtime 缓存。"""
    global _CACHE
    with _LOCK:
        stamp = SONG_DIR.stat().st_mtime if SONG_DIR.exists() else 0
        if _CACHE[0] == stamp and _CACHE[1]:
            return _CACHE[1]
        meta = _meta()
        songs: list[dict] = []
        for f in sorted(SONG_DIR.iterdir()):
            if not f.is_file() or f.suffix.lower() not in SUPPORTED:
                continue
            m = meta.get(f.name, {})
            songs.append({
                "id": f.stem,
                "file": f.name,
                "title": str(m.get("title") or f.stem),
                "artist": str(m.get("artist") or "未知"),
                "tags": [str(t) for t in (m.get("tags") or [])],
                "url": f"/songs/{f.name}",
                "duration": _duration(f),
            })
        _CACHE = (stamp, songs)
        return songs


def _bigrams(text: str) -> set[str]:
    t = re.sub(r"[\s\W_]+", "", (text or "").lower())
    return {t[i:i + 2] for i in range(len(t) - 1)} if len(t) > 1 else set()


def find(query: str) -> tuple[dict | None, float]:
    """按标题/标签/歌手匹配，返回 (歌曲, 得分)；得分 < 1.2 视为没找到。"""
    songs = scan()
    if not songs:
        return None, 0.0
    q = (query or "").strip()
    if not q:
        return random.choice(songs), 1.0
    qn = q.lower()
    qb = _bigrams(qn)
    best, best_score = None, 0.0
    for s in songs:
        haystacks = [s["title"], s["artist"], " ".join(s["tags"]), s["file"]]
        score = 0.0
        for h in haystacks:
            hn = (h or "").lower()
            if not hn:
                continue
            if hn == qn:
                score = max(score, 3.0)
            elif len(qn) >= 2 and (qn in hn or hn in qn):
                score = max(score, 2.0)
            else:
                inter = qb & _bigrams(hn)
                if inter:
                    score = max(score, 1.2 + 0.15 * len(inter))
        if score > best_score:
            best, best_score = s, score
    if best_score >= 1.2:
        return best, best_score
    return None, best_score


# ---------------------------------------------------------------- 点歌台

class Jukebox:
    def __init__(self) -> None:
        self.queue: list[dict] = []
        self.current: dict | None = None
        self.started_at: float = 0.0
        self.history: list[dict] = []
        self.seq = 0
        self.lock = threading.RLock()

    # ---- 入队 ----
    def request(self, user: str, query: str = "", gift: str = "",
                priority: int = 0, max_queue: int = 10, cfg: dict | None = None) -> dict:
        """点歌入队。

        注意：**网络部分（搜歌 / 取直链）一律不持锁**。
        以前整段都包在 self.lock 里，音乐接口慢的时候（一次 10 秒超时×3 首）
        控制台轮询 /api/state、/api/song/status 全被堵住，看起来就是「点歌点不到」。
        """
        cfg = cfg or {}
        songs_cfg = cfg.get("songs") or {}
        with self.lock:
            if len(self.queue) >= max_queue:
                return {"ok": False, "reason": "full", "queue": len(self.queue)}

        local, score = find(query)
        song = None
        online = False
        note = ""
        has_query = bool(query.strip())
        online_on = bool(songs_cfg.get("online", True)) and has_query
        prefer_online = songs_cfg.get("prefer_online", True)
        if online_on and prefer_online:
            hit, got, note = self._online_pick(query, cfg)
            if hit and got:
                song = self._online_item(hit, got)
                score, online = 3.0, True
        if song is None and local is not None:
            song = local
        if song is None and online_on and not prefer_online:
            hit, got, note = self._online_pick(query, cfg)
            if hit and got:
                song = self._online_item(hit, got)
                score, online = 3.0, True
        matched = song is not None
        if song is None:
            songs = scan()
            if not songs:
                return {"ok": False, "reason": "empty", "note": note}
            song = random.choice(songs)
        item = {
            "seq": 0,
            "id": song["id"],
            "title": song["title"],
            "artist": song["artist"],
            "url": song["url"],
            "duration": song["duration"],
            "user": user or "观众",
            "gift": gift,
            "query": query,
            "priority": priority,
            "at": time.time(),
            "matched": matched,
            "online": online,
            "source": song.get("source") or "",
            "oid": song.get("oid") or "",
            "pic": song.get("pic") or "",
            "note": note,
        }
        if online:
            # 本地缓存没准备好之前先用远端直链，下完自动切本地（防盗链更稳）
            if songs_cfg.get("cache_download", True):
                music.fetch_async(item, cfg, on_done=lambda res, it=item: self._on_cached(it, res))
            item["url"] = music.local_url(item) or item["url"]
        with self.lock:
            self.seq += 1
            item["seq"] = self.seq
            self.queue.append(item)
            self.queue.sort(key=lambda x: (-x["priority"], x["seq"]))
            position = self.queue.index(item) + 1
        return {"ok": True, "song": item, "matched": matched, "online": online,
                "note": note, "position": position, "score": round(score, 2)}

    # ---- 在线搜歌 ----
    def _online_item(self, hit: dict, got: dict) -> dict:
        songs_cfg_guard = float(got.get("seconds") or 0)
        return {
            "id": f"{hit['source']}_{hit['id']}",
            "file": "",
            "title": hit["name"],
            "artist": hit["artist"],
            "tags": [hit.get("source_name") or hit["source"]],
            "url": got["url"],
            "duration": songs_cfg_guard or 240.0,
            "source": hit["source"],
            "oid": hit["id"],
            "pic": hit.get("pic") or "",
        }

    def _online_pick(self, query: str, cfg: dict) -> tuple[dict | None, dict | None, str]:
        songs_cfg = cfg.get("songs") or {}
        limit = max(1, min(10, int(songs_cfg.get("search_limit") or 3)))
        longest = float(songs_cfg.get("max_duration") or 420)
        try:
            hits = music.search(query, cfg, limit=limit)
        except Exception as exc:  # 网络问题不该影响点歌
            return None, None, f"在线搜索失败：{str(exc)[:60]}"
        if not hits:
            return None, None, "在线没搜到"
        for hit in hits:
            try:
                got = music.resolve(hit, cfg)
            except Exception:
                got = {"ok": False}
            if not got.get("ok"):
                continue
            seconds = float(got.get("seconds") or 0)
            if longest and seconds and seconds > longest:
                continue
            return hit, got, ""
        return hits[0], None, "搜到了但拿不到播放地址"

    def _on_cached(self, item: dict, result: dict) -> None:
        url = music.local_url(item)
        if url:
            item["url"] = url

    def _refresh_url(self, item: dict) -> dict:
        """播放前再确认一次：缓存好了就用本地，没缓存就重新取一次直链（会过期）。"""
        item["url"] = music.local_url(item) or item["url"]
        return item


    # ---- 播放 ----
    def start_next(self) -> dict | None:
        with self.lock:
            if self.current is not None:
                return self.current
            if not self.queue:
                return None
            item = self.queue.pop(0)
            if item.get("online"):
                item = self._refresh_url(item)
            self.current = item
            self.started_at = time.time()
            self.history.append(item)
            self.history = self.history[-30:]
            return item

    def finish(self, seq: int | None = None) -> dict | None:
        """当前歌曲结束（客户端回报或超时兜底），返回下一首（自动续播）。"""
        with self.lock:
            if self.current is None:
                return None
            if seq is not None and int(seq) != self.current["seq"]:
                return self.current  # 过期回报，忽略
            self.current = None
            return self.start_next()

    def skip(self) -> dict | None:
        with self.lock:
            self.current = None
            return self.start_next()

    def stop(self) -> None:
        with self.lock:
            self.current = None
            self.queue.clear()

    def status(self) -> dict:
        library_size = len(scan())          # 目录扫描放锁外面，别拖慢接口
        with self.lock:
            cur = dict(self.current) if self.current else None
            elapsed = round(time.time() - self.started_at, 1) if self.current else 0
            return {
                "playing": self.current is not None,
                "current": cur,
                "elapsed": elapsed,
                "queue": [dict(x) for x in self.queue],
                "queue_len": len(self.queue),
                "library_size": library_size,
            }


JUKEBOX = Jukebox()


# ---------------------------------------------------------------- 指令识别

SONG_CMD = re.compile(
    r"(?:点歌|点一首|来一首|来首|放一首|放首|唱一首|唱首|想听)\s*[《\"“]?\s*(.*?)\s*[》\"”]?$"
)


def parse_command(text: str) -> str | None:
    """从弹幕里解析点歌请求，返回歌名（可能为空字符串=随机）。"""
    text = (text or "").strip()
    if not text:
        return None
    m = SONG_CMD.search(text)
    if not m:
        return None
    query = (m.group(1) or "").strip(" 《》\"“”")
    return query
