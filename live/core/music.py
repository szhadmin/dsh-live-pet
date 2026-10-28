"""在线音乐：网易云 / QQ音乐 / 酷狗 / 酷我 / 咪咕 搜索 + 取播放直链。

走 Meting 兼容的公共 API（默认 music-api.gdstudio.xyz，可在设置里换），
只用标准库，不引入新依赖。搜索返回统一结构，取直链失败会退回下一个源。

用法：
    music.search("晴天", cfg)          -> [{id,name,artist,album,source,pic}]
    music.resolve(item, cfg)           -> {ok,url,br,size,seconds}
    music.cache(item, cfg)             -> 本地缓存路径（后台下载用）

抖音音乐没有公开接口，所以 "douyin" 源用「抖音热歌」关键词在网易云/QQ 里检索，
能点到绝大多数抖音上流行的歌。
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

API_DEFAULT = "https://music-api.gdstudio.xyz/api.php"

# 源代号 → 界面显示名
SOURCES = {
    "netease": "网易云",
    "tencent": "QQ音乐",
    "kugou": "酷狗",
    "kuwo": "酷我",
    "migu": "咪咕",
    "douyin": "抖音热歌",
}

# 抖音热歌：没有官方接口，用关键词去曲库里捞
DOUYIN_HINTS = ("抖音", "热歌", "神曲", "BGM")

_CACHE: dict[tuple, tuple[float, object]] = {}
_LOCK = threading.RLock()
_DOWNLOADING: set[str] = set()


# ---------------------------------------------------------------- 基础请求

def _api(cfg: dict | None = None) -> str:
    base = ((cfg or {}).get("songs") or {}).get("online_api") or API_DEFAULT
    return str(base).strip() or API_DEFAULT


def _timeout(cfg: dict | None = None) -> float:
    return float(((cfg or {}).get("songs") or {}).get("online_timeout") or 10)


def _get_json(url: str, timeout: float = 10):
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                      "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
        "Referer": "https://music.gdstudio.xyz/",
        "Accept": "application/json, text/plain, */*",
    })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
    # 这个 API 的 Content-Type 不带 charset，直接按 UTF-8 解，别让 urllib 猜成 latin-1
    text = raw.decode("utf-8", errors="replace").strip()
    return json.loads(text)


def _memo(key: tuple, ttl: float, maker, cache_empty: bool = False):
    """带 TTL 的小缓存。

    默认「空的 / 失败的结果不进缓存」：音乐接口偶尔超时或限流时，如果把 []
    或 {"ok": False} 当成结果缓存十分钟，直播间就会一直「搜不到 / 拿不到播放地址」，
    只能重启服务——这是之前的真 bug。
    """
    now = time.time()
    with _LOCK:
        hit = _CACHE.get(key)
        if hit and now - hit[0] < ttl:
            return hit[1]
    value = maker()
    keep = bool(value) if not cache_empty else True
    if isinstance(value, dict):          # resolve 的结果：只有成功才值得缓存
        keep = bool(value.get("ok"))
    with _LOCK:
        if keep:
            _CACHE[key] = (time.time(), value)
            if len(_CACHE) > 300:
                for k in list(_CACHE)[:80]:
                    _CACHE.pop(k, None)
        else:
            _CACHE.pop(key, None)        # 顺手把旧的坏结果扔掉
    return value


# ---------------------------------------------------------------- 搜索

def _norm_source(source: str | None) -> str:
    src = (source or "netease").strip().lower()
    return src if src in SOURCES else "netease"


def _reshape(raw: list, source: str) -> list[dict]:
    out: list[dict] = []
    for item in raw or []:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        if not name:
            continue
        artists = item.get("artist") or item.get("artists") or []
        if isinstance(artists, str):
            artists = [artists]
        artist = " / ".join(str(a).strip() for a in artists if str(a).strip()) or "未知"
        sid = str(item.get("id") or item.get("url_id") or "").strip()
        if not sid:
            continue
        out.append({
            "id": sid,
            "name": name[:80],
            "artist": artist[:60],
            "album": str(item.get("album") or "")[:60],
            "source": source,
            "source_name": SOURCES.get(source, source),
            "pic": str(item.get("pic_id") or ""),
            "duration": float(item.get("duration") or 0) / 1000.0 if item.get("duration") else 0.0,
        })
    return out


def search(query: str, cfg: dict | None = None, limit: int = 5,
           source: str | None = None, timeout: float | None = None) -> list[dict]:
    """在线搜歌。query 为空返回空列表（让上层走随机/本地）。"""
    q = (query or "").strip()
    if not q:
        return []
    cfg = cfg or {}
    src = _norm_source(source or ((cfg.get("songs") or {}).get("source") or "netease"))
    limit = max(1, min(20, int(limit or 5)))
    wait = float(timeout or _timeout(cfg))
    # 抖音热歌 → 换个说法去曲库捞
    real_src = "netease" if src == "douyin" else src
    keyword = q
    if src == "douyin" and not any(h in q for h in DOUYIN_HINTS):
        keyword = q

    def make():
        url = (f"{_api(cfg)}?types=search&source={urllib.parse.quote(real_src)}"
               f"&name={urllib.parse.quote(keyword)}&count={limit}&pages=1")
        try:
            data = _get_json(url, wait)
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError,
                json.JSONDecodeError, OSError, ValueError):
            return []
        return _reshape(data if isinstance(data, list) else [], src)

    return _memo(("search", real_src, keyword, limit), 600, make)


def hot_douyin(cfg: dict | None = None, limit: int = 8, budget: float = 4.0) -> list[dict]:
    """抖音热歌榜：拿几个热词去网易云捞一圈，去重后返回。

    budget 是总时间预算（秒）—— 礼物点歌会调它，网络慢时宁可少几首，
    也不能把直播间的回复卡住。
    """
    cfg = cfg or {}
    deadline = time.time() + max(1.0, float(budget))
    words = ("抖音热歌", "抖音热门", "抖音BGM")
    seen: set[str] = set()
    out: list[dict] = []
    for w in words:
        left = deadline - time.time()
        if left <= 0.5:
            break
        for hit in search(w, cfg, limit=limit, source="netease",
                          timeout=min(2.5, max(0.8, left))):
            key = f"{hit['name']}|{hit['artist']}"
            if key in seen:
                continue
            seen.add(key)
            out.append(hit)
        if len(out) >= limit:
            break
    if not out:          # 接口抽风时再来一轮（空结果不会被缓存，重试通常就好了）
        for w in ("热歌", "热门歌曲"):
            for hit in search(w, cfg, limit=limit, source="netease", timeout=3.0):
                key = f"{hit['name']}|{hit['artist']}"
                if key not in seen:
                    seen.add(key)
                    out.append(hit)
            if out:
                break
    return out[:limit]


# ---------------------------------------------------------------- 取直链

def resolve(item: dict, cfg: dict | None = None, br: int | None = None) -> dict:
    """把搜索结果换成可播放的直链。"""
    cfg = cfg or {}
    src = _norm_source(item.get("source"))
    sid = str(item.get("id") or "").strip()
    if not sid:
        return {"ok": False, "error": "缺少歌曲 id"}
    want = int(br or ((cfg.get("songs") or {}).get("br") or 320))

    def make():
        for quality in (want, 192, 128):
            url = (f"{_api(cfg)}?types=url&source={urllib.parse.quote(src)}"
                   f"&id={urllib.parse.quote(sid)}&br={quality}")
            try:
                data = _get_json(url, _timeout(cfg))
            except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError,
                    json.JSONDecodeError, OSError, ValueError):
                continue
            if not isinstance(data, dict):
                continue
            link = str(data.get("url") or "").strip()
            if not link or not link.startswith("http"):
                continue
            size = int(data.get("size") or 0)
            bitrate = int(data.get("br") or quality) or quality
            seconds = round(size / (bitrate * 1000 / 8), 1) if size and bitrate else 0.0
            return {"ok": True, "url": link, "br": bitrate, "size": size,
                    "seconds": seconds, "source": src, "id": sid}
        return {"ok": False, "error": "拿不到播放直链（可能版权受限）", "source": src, "id": sid}

    return _memo(("url", src, sid, want), 900, make)


def lyric(item: dict, cfg: dict | None = None) -> str:
    src = _norm_source(item.get("source"))
    sid = str(item.get("id") or "").strip()
    if not sid:
        return ""
    url = f"{_api(cfg)}?types=lyric&source={urllib.parse.quote(src)}&id={urllib.parse.quote(sid)}"
    try:
        data = _get_json(url, _timeout(cfg))
    except Exception:
        return ""
    return str((data or {}).get("lyric") or "")[:20000]


# ---------------------------------------------------------------- 本地缓存

def cache_dir() -> Path:
    from .paths import DATA_DIR
    d = DATA_DIR / "music"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _cache_name(item: dict) -> str:
    src = _norm_source(item.get("source"))
    sid = re.sub(r"[^0-9A-Za-z_-]", "", str(item.get("id") or ""))[:40]
    return f"{src}_{sid}.mp3"


def cached(item: dict) -> Path | None:
    p = cache_dir() / _cache_name(item)
    return p if p.is_file() and p.stat().st_size > 40960 else None


def fetch_to_cache(item: dict, cfg: dict | None = None, timeout: float = 25) -> dict:
    """把一首在线歌下载到 data/music/，返回 {ok,path,error}。"""
    cfg = cfg or {}
    name = _cache_name(item)
    dest = cache_dir() / name
    if cached(item):
        return {"ok": True, "path": str(dest), "cached": True}
    with _LOCK:
        if name in _DOWNLOADING:
            return {"ok": False, "error": "正在下载", "pending": True}
        _DOWNLOADING.add(name)
    try:
        got = resolve(item, cfg)
        if not got.get("ok"):
            return {"ok": False, "error": got.get("error") or "直链获取失败"}
        req = urllib.request.Request(got["url"], headers={
            "User-Agent": "Mozilla/5.0",
            "Referer": "https://music.163.com/",
        })
        tmp = dest.with_suffix(".part")
        with urllib.request.urlopen(req, timeout=timeout) as resp, open(tmp, "wb") as fh:
            while True:
                chunk = resp.read(262144)
                if not chunk:
                    break
                fh.write(chunk)
        if tmp.stat().st_size < 40960:
            tmp.unlink(missing_ok=True)
            return {"ok": False, "error": "下载到的文件太小，可能被拦了"}
        tmp.replace(dest)
        return {"ok": True, "path": str(dest), "bytes": dest.stat().st_size}
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as exc:
        return {"ok": False, "error": str(exc)[:120]}
    finally:
        with _LOCK:
            _DOWNLOADING.discard(name)


def fetch_async(item: dict, cfg: dict | None = None, on_done=None) -> None:
    def run():
        res = fetch_to_cache(item, cfg)
        if on_done:
            try:
                on_done(res)
            except Exception:
                pass
    threading.Thread(target=run, daemon=True).start()


def local_url(item: dict) -> str:
    """缓存命中就返回本地 URL（经过 /music/ 静态路由）。"""
    if not item.get("online"):
        return ""
    p = cached(item)
    return f"/music/{p.name}" if p else ""


def clear_cache() -> int:
    """清空搜索/直链缓存：接口抽风后想立刻恢复，不用重启服务。"""
    with _LOCK:
        n = len(_CACHE)
        _CACHE.clear()
    return n


def status(cfg: dict | None = None) -> dict:
    cfg = cfg or {}
    songs_cfg = cfg.get("songs") or {}
    d = cache_dir()
    files = [f for f in d.iterdir() if f.is_file() and f.suffix == ".mp3"]
    size = sum(f.stat().st_size for f in files)
    return {
        "online": bool(songs_cfg.get("online", True)),
        "source": _norm_source(songs_cfg.get("source")),
        "source_name": SOURCES.get(_norm_source(songs_cfg.get("source")), ""),
        "sources": SOURCES,
        "api": _api(cfg),
        "br": int(songs_cfg.get("br") or 320),
        "cached_files": len(files),
        "cached_mb": round(size / 1048576, 1),
        "dir": str(d),
    }
