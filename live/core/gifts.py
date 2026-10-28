"""抖音礼物表：名字 / 抖币 / 折合人民币 / 图标 / 命中哪个动作。

数据来源有两层：

1. **内置快照** `defaults/douyin-gifts.json`——从抖音直播礼物列表接口
   （`live.douyin.com/webcast/gift/list/`）抓下来、按项目规则筛过的子集，
   图标在 `gifs/gifts/`。打包后随 exe 一起走，离线可用。
2. **运行期学习** `data/gifts-learned.json`——直播间真实收到礼物时，
   把 name / diamond / icon 记下来（图标顺手下载），列表明细会自己长全。

抖币 → 人民币按「10 抖币 = 1 元」折算（和 app.py 里 diamond 的算法一致）。
"""
from __future__ import annotations

import json
import re
import threading
import time
import urllib.request
from pathlib import Path

from . import gift_actions

_lock = threading.RLock()
_cache: dict | None = None
_learned_cache: dict | None = None
_learned_mtime: float = 0.0

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36")


def _paths() -> tuple[Path, Path, Path]:
    """(内置快照, 运行期学习文件, 运行期图标目录)。

    内置图标随包发布在 gifs/gifts/（只读），运行期新下载的图标落到
    data/gift-icons/（可写），打包成 exe 后也不会写进只读的临时解包目录。
    """
    from .paths import BASE_DIR, CODE_DIR, DATA_DIR, GIFS_DIR
    shipped = CODE_DIR / "defaults" / "douyin-gifts.json"
    if not shipped.is_file():
        shipped = BASE_DIR / "defaults" / "douyin-gifts.json"
    learned = DATA_DIR / "gifts-learned.json"
    icons = DATA_DIR / "gift-icons"
    return shipped, learned, icons, GIFS_DIR / "gifts"


def _read_json(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def shipped_gifts() -> list[dict]:
    """内置快照（随 exe 打包）。"""
    global _cache
    with _lock:
        if _cache is None:
            shipped, _, _, _ = _paths()
            rows = _read_json(shipped).get("gifts") or []
            _cache = {str(r.get("name") or ""): r for r in rows if r.get("name")}
        return list(_cache.values())


def learned_gifts() -> dict:
    """运行期学到的礼物。按文件 mtime 失效，外面手改 json 也能立刻看到。"""
    global _learned_cache, _learned_mtime
    with _lock:
        _, learned, _, _ = _paths()
        try:
            mtime = learned.stat().st_mtime
        except OSError:
            mtime = 0.0
        if _learned_cache is None or mtime != _learned_mtime:
            _learned_cache = _read_json(learned).get("gifts") or {}
            _learned_mtime = mtime
        return _learned_cache


def _save_learned() -> None:
    global _learned_mtime
    _, learned, _, _ = _paths()
    try:
        learned.parent.mkdir(parents=True, exist_ok=True)
        learned.write_text(json.dumps({"gifts": learned_gifts()}, ensure_ascii=False, indent=2),
                           encoding="utf-8")
        _learned_mtime = learned.stat().st_mtime
    except OSError:
        pass


def _icon_name(gift_id: str, url: str) -> str:
    ext = ".png"
    for e in (".webp", ".png", ".jpg", ".jpeg", ".gif"):
        if url.lower().split("?")[0].endswith(e):
            ext = e
            break
    safe = re.sub(r"[^0-9A-Za-z_-]", "", str(gift_id))[:24] or "gift"
    return f"{safe}{ext}"


def _download_icon(url: str, gift_id: str) -> str:
    """下图标到 data/gift-icons/，返回可直接访问的 URL 路径（失败返回空）。"""
    if not url.startswith("http"):
        return ""
    _, _, learned_icons, _ = _paths()
    name = _icon_name(gift_id, url)
    dest = learned_icons / name
    if dest.is_file() and dest.stat().st_size > 500:
        return "/gift-icons/" + name
    try:
        learned_icons.mkdir(parents=True, exist_ok=True)
        req = urllib.request.Request(url, headers={
            "User-Agent": UA, "Referer": "https://live.douyin.com/",
            "Accept": "image/webp,image/apng,image/*,*/*;q=0.8",
        })
        with urllib.request.urlopen(req, timeout=10) as resp:
            blob = resp.read()
        if len(blob) < 500:
            return ""
        dest.write_bytes(blob)
        return "/gift-icons/" + name
    except Exception:
        return ""


def learn(name: str, gift_id: str = "", diamond: int = 0, icon_url: str = "",
          describe: str = "") -> None:
    """直播间收到礼物时调用：记下名字 / 抖币 / 图标，列表会越来越全。

    只在「学到的东西更好」时才写：抖币 0 / 图标空 一律不覆盖已有值，
    否则运行期会把内置快照里带图标的那条盖成 🎁 占位。
    """
    name = str(name or "").strip()
    if not name:
        return
    gid = re.sub(r"[^0-9A-Za-z_-]", "", str(gift_id or ""))[:24]
    shipped = shipped_index().get(name) or {}
    with _lock:
        data = learned_gifts()
        old = dict(data.get(name) or {})
        changed = False
        if diamond and int(diamond) != int(old.get("diamond") or 0):
            old["diamond"] = int(diamond)
            old["cny"] = round(int(diamond) / 10.0, 2)
            changed = True
        if gid and old.get("id") != gid:
            old["id"] = gid
            changed = True
        if icon_url and old.get("icon_url") != icon_url:
            old["icon_url"] = icon_url
            changed = True
        if describe and not old.get("describe"):
            old["describe"] = describe
            changed = True
        if not changed and (old.get("icon_local") or old.get("icon")):
            return
        # 图标：本地已有就不动；否则下载；再不行就沿用内置快照里的图标
        if not old.get("icon_local"):
            local = _download_icon(icon_url, gid or name) if icon_url else ""
            if local:
                old["icon_local"] = local
            elif shipped.get("icon"):
                old["icon"] = shipped["icon"]
        if not old.get("diamond") and shipped.get("diamond"):
            old["diamond"] = int(shipped["diamond"])
        old["name"] = name
        old.setdefault("cny", round(int(old.get("diamond") or 0) / 10.0, 2))
        old["seen_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
        data[name] = old
        _save_learned()


def learn_async(name: str, gift_id: str = "", diamond: int = 0,
                icon_url: str = "", describe: str = "") -> None:
    """别在弹幕/礼物线程里等下载，扔后台。

    连击礼物一条消息一次调用，所以先做个便宜的命中判断：
    已经记过、图标也有了、抖币也没变，就不用开线程。
    """
    name = str(name or "").strip()
    if not name:
        return
    try:
        known = lookup(name) or {}
        gid = re.sub(r"[^0-9A-Za-z_-]", "", str(gift_id or ""))[:24]
        has_icon = bool(known.get("icon_local") or known.get("icon") or known.get("icon_url"))
        same = (int(known.get("diamond") or 0) == int(diamond or 0)
                and has_icon
                and (not gid or str(known.get("id") or "") == gid))
        if same:
            return
    except Exception:
        pass
    threading.Thread(target=learn, args=(name, gift_id, diamond, icon_url, describe),
                     daemon=True).start()


def _icon_path(entry: dict) -> str:
    """给前端的图标地址：运行期下载的 > 随包的内置图标 > 原始 CDN 直链。"""
    local = str(entry.get("icon_local") or "").strip()
    if local:
        return local
    icon = str(entry.get("icon") or "").strip()
    if icon:
        return "/gifs/gifts/" + icon
    return str(entry.get("icon_url") or "").strip()


def icon_url(entry: dict) -> str:
    """公开版：其它模块（礼物菜单）要拿图标地址时用这个。"""
    return _icon_path(entry or {})


def shipped_index() -> dict:
    """内置快照，name → row（带缓存）。"""
    return {str(r.get("name") or ""): r for r in shipped_gifts()}


_EMPTY = (None, "", 0, 0.0, [], {})


def _merge(base: dict, over: dict) -> dict:
    """字段级合并：学习到的值只在「有内容」时才覆盖内置值。

    以前是整条覆盖，运行期只记到「玫瑰 5 抖币、没有图标」就把内置的
    「玫瑰 1 抖币 + 图标」顶掉了，画面就退化成 🎁 占位。
    """
    out = dict(base or {})
    for k, v in (over or {}).items():
        if v in _EMPTY and out.get(k) not in _EMPTY:
            continue
        out[k] = v
    return out


def merged_gifts() -> dict:
    """内置 + 运行期学习，字段级合并后的完整礼物表。"""
    merged = {name: dict(row) for name, row in shipped_index().items()}
    for name, row in learned_gifts().items():
        merged[name] = _merge(merged.get(name) or {}, row)
    return merged


def lookup(name: str) -> dict | None:
    """按礼物名查一条（内置 + 学习合并后）。"""
    name = str(name or "").strip()
    if not name:
        return None
    return merged_gifts().get(name)


def table(cfg: dict | None = None, limit: int = 400) -> list[dict]:
    """礼物 → 动作对照表：图标 / 抖币 / 折合人民币 / 命中动作 / 动作动图 / 停留秒数。"""
    cfg = cfg or {}
    merged = merged_gifts()
    learned = learned_gifts()

    eff = gift_actions.action_config(cfg)
    out: list[dict] = []
    for name, row in merged.items():
        action = gift_actions.resolve(name, float(row.get("cny") or 0), cfg)
        a = action or {}
        gif = (eff.get(a.get("action") or "") or {}).get("gif") or a.get("gif") or ""
        out.append({
            "name": name,
            "id": str(row.get("id") or ""),
            "diamond": int(row.get("diamond") or 0),
            "cny": float(row.get("cny") or 0),
            "icon": _icon_path(row),
            "describe": str(row.get("describe") or ""),
            "action": a.get("action") or "",
            "action_label": gift_actions.ACTION_LABELS.get(a.get("action") or "", ("", ""))[0],
            "action_gif": gif,
            "hold": float(a.get("hold") or gift_actions.DEFAULT_HOLD),
            "matched": bool(a),
            "learned": name in learned,
        })
    out.sort(key=lambda r: (r["diamond"] or 10 ** 9, r["name"]))
    return out[:limit]


def summary(cfg: dict | None = None) -> dict:
    rows = table(cfg)
    shipped, learned, learned_icons, shipped_icons = _paths()
    return {
        "total": len(rows),
        "learned": sum(1 for r in rows if r["learned"]),
        "with_icon": sum(1 for r in rows if r["icon"]),
        "shipped_file": str(shipped),
        "learned_file": str(learned),
        "icon_dir": str(learned_icons),
        "shipped_icon_dir": str(shipped_icons),
    }
