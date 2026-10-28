"""礼物 → 动作：观众送什么礼物，鲸鱼就做什么动作。

规则在 settings.json 的 gift_actions.rules 里，形如：

    {"match": ["小星星", "星星"], "action": "dance", "fx": "stars",
     "emotion": "happy", "line": "谢谢{user}的{gift}，本鲸原地转三圈！"}

匹配顺序：从上往下，第一条命中的生效；match 支持
  - 礼物名关键词（子串命中即可）
  - "*" 或 "default"：兜底规则
  - "/正则/"：正则匹配
  - ">=价值" 这种写法交给 over 字段，不写在 match 里

不配也能跑：内置一套常见礼物的默认动作。
"""
from __future__ import annotations

import random
import re

# 动作 → 舞台特效 + 舞台用的鲸鱼动作 class
ACTION_PRESETS = {
    "hello":     {"fx": "bubbles",  "gif": "whale_walking",     "emotion": "calm"},
    "dance":     {"fx": "stars",    "gif": "whale_happy",       "emotion": "happy"},
    "spin":      {"fx": "sparkle",  "gif": "whale_happy",       "emotion": "happy"},
    "heart":     {"fx": "hearts",   "gif": "whale_happy",       "emotion": "happy"},
    "eat":       {"fx": "food",     "gif": "whale_eating",      "emotion": "eating"},
    "sing":      {"fx": "notes",    "gif": "whale_happy",       "emotion": "happy"},
    "bow":       {"fx": "sparkle",  "gif": "whale_mischievous", "emotion": "mischievous"},
    "cheer":     {"fx": "confetti", "gif": "whale_happy",       "emotion": "happy"},
    "sleep":     {"fx": "bubbles",  "gif": "whale_walking",     "emotion": "calm"},
    "fireworks": {"fx": "fireworks", "gif": "whale_happy",      "emotion": "happy"},
    # ---- 新动作：素材已是真实文件名（whale_crying / whale_cooking / whale_coding / whale_tv）----
    "cry":       {"fx": "bubbles",  "gif": "whale_crying",     "emotion": "cry"},
    "cook":      {"fx": "food",     "gif": "whale_cooking",    "emotion": "cook"},
    "code":      {"fx": "sparkle",  "gif": "whale_coding",     "emotion": "code"},
    "sad":       {"fx": "bubbles",  "gif": "whale_unhappy",    "emotion": "sad"},
    "sofa":      {"fx": "notes",    "gif": "whale_tv",         "emotion": "sofa"},
}

# 礼物答谢的称呼：随机撒一个，避免每条都是「谢谢XX」
HONORIFICS = ("金主", "大佬", "铁子", "老板")

# 动作的中文名 + 说明（控制台「礼物动作」页的对照表用）
ACTION_LABELS = {
    "hello": ("打招呼", "摆摆尾鳍跟你问好"),
    "dance": ("跳舞", "原地扭起来"),
    "spin": ("原地转圈", "转三圈，撒一圈星星"),
    "heart": ("比心", "把心收进抽屉"),
    "eat": ("开饭", "三口吃完"),
    "sing": ("唱歌", "键盘当伴奏"),
    "bow": ("鞠躬", "弯腰道谢"),
    "cheer": ("欢呼", "蹦起来撒花"),
    "sleep": ("打盹", "趴下眯一会儿"),
    "fireworks": ("放烟花", "为你放一场烟花"),
    "cry": ("大哭", "眼泪直接掉进海里"),
    "cook": ("做饭", "围裙一系就开火"),
    "code": ("敲代码", "哒哒哒现场写一段"),
    "sad": ("委屈", "尾鳍垂下来，不吭声了"),
    "sofa": ("躺沙发看电视", "躺平，遥控器归我"),
}

# 特效中文名（舞台飘的那个）
FX_LABELS = {
    "stars": "星星", "hearts": "爱心", "food": "食物", "sparkle": "闪光",
    "confetti": "彩带", "bubbles": "气泡", "notes": "音符", "fireworks": "烟花",
}


# 没配规则时的默认表：礼物名关键词 → 动作
# 顺序有讲究：大礼物（烟花/跑车/花火）要排在「花」这种宽泛词前面，否则会被截胡；
# 台词里的 {boss} 会随机替换成 金主 / 大佬 / 铁子 / 老板
#
# ★ 直播画面上那张「刷礼菜单」用的就是这几条，两者同源：
#   小心心→敲代码 / 玫瑰→比心 / 棒棒糖→开饭 / 大啤酒→大哭
#   鲜花→鞠躬 / 蛋糕→做饭 / 跑车→躺沙发看电视
DEFAULT_RULES = [
    # ---- 大礼物：本鲸直接躺沙发上歇着看电视 ----
    {"match": ["跑车", "嘉年华", "火箭", "城堡", "游艇", "飞机", "花火", "烟花", "抖音1号", "一号"],
     "action": "sofa", "fx": "notes",
     "lines": ["{user}的{gift}！！{boss}这一下把本鲸砸瘫在沙发上了，电视归我，遥控器也归我！",
               "哎哟喂{boss}{user}，{gift}一到手，本鲸当场躺平看电视，今晚不加班了！"]},
    # 任何价值 ≥ 100 元的礼物都够本鲸躺一次沙发
    {"over": 100, "match": ["*"], "action": "sofa", "fx": "notes",
     "lines": ["{boss}{user}的{gift}！这礼太重了，本鲸先躺沙发上缓三分钟。"]},
    # ---- 吃的做大餐：当场做饭 ----
    {"match": ["火锅", "吃饭", "饭", "夜宵", "奶茶", "零食", "面包", "外卖", "泡面", "干饭",
               "蛋糕", "甜甜圈"],
     "action": "cook", "fx": "food",
     "lines": ["{user}的{gift}！本鲸围裙一系就开火，{boss}你等着，三分钟出锅。",
               "{boss}{user}送{gift}，那我不写代码了，先做饭——工位锅都热上了。"]},
    # ---- 小零嘴：直接开吃 ----
    {"match": ["棒棒糖", "糖果", "糖"],
     "action": "eat", "fx": "food",
     "lines": ["{user}的{gift}，本鲸当场开吃，甜得尾鳍都在打拍子。",
               "{boss}的{gift}到手，本鲸三口解决，谢谢谢谢。"]},
    # ---- 苦的、闷的：大哭一场 ----
    {"match": ["啤酒", "酒", "干杯", "苦咖啡", "咖啡", "眼泪", "哭"],
     "action": "cry", "fx": "bubbles",
     "lines": ["{user}的{gift}……{boss}，本鲸边喝边哭，这需求我改还不行吗。",
               "{boss}送的{gift}，我一口下去眼泪就下来了，深海都不用加水了。"]},
    # ---- 委屈 / 被欺负：垂尾鳍 ----
    {"match": ["安慰", "抱抱", "委屈", "摸摸头", "别哭", "拍拍"],
     "action": "sad", "fx": "bubbles",
     "lines": ["{user}的{gift}，本鲸尾鳍一垂，{boss}你可算来安慰我了。",
               "收到{boss}的{gift}，我这委屈值瞬间掉一半，谢谢你还记得我。"]},
    # ---- 最常见的小礼物：敲代码 ----
    {"match": ["小心心", "比心", "心心"],
     "action": "code", "fx": "sparkle",
     "lines": ["收到{user}的{gift}，{boss}你放心，本鲸当场敲两行代码给你看。",
               "{user}的{gift}到了！键盘声起——哒哒哒，这段是给你写的。"]},
    # ---- 玫瑰：比心 ----
    {"match": ["玫瑰", "真爱玫瑰"],
     "action": "heart", "fx": "hearts",
     "lines": ["{user}的{gift}，本鲸把心收进抽屉了，{boss}这份我记着。",
               "哇{boss}送{gift}，我这尾鳍当场比了个心，收到没？"]},
    # ---- 鲜花 / 花束：鞠躬 ----
    {"match": ["鲜花", "花束", "百合", "花花", "花"],
     "action": "bow", "fx": "hearts",
     "lines": ["谢谢{user}的{gift}，插在显示器旁边，代码都好看了，{boss}眼光真好。",
               "{boss}{user}的{gift}，本鲸工位当场开花店，给你鞠一个。"]},
    {"match": ["小星星", "星星", "星"],
     "action": "spin", "fx": "stars",
     "lines": ["哇，{user}的{gift}！本鲸给你原地转三圈，星星都甩出来了。"]},
    {"match": ["*"], "action": "bow", "fx": "sparkle",
     "lines": ["谢谢{boss}{user}的{gift}，工位账本上给你记一笔。"]},
]

_FX_ALLOWED = {"stars", "hearts", "food", "sparkle", "confetti", "bubbles", "notes", "fireworks", ""}


def _norm(value) -> str:
    return str(value or "").strip()


def _match_one(pattern: str, gift: str) -> bool:
    p = _norm(pattern)
    if not p:
        return False
    if p in ("*", "default", "默认", "其它", "其他"):
        return True
    if len(p) >= 2 and p.startswith("/") and p.endswith("/"):
        try:
            return bool(re.search(p[1:-1], gift))
        except re.error:
            return False
    return p in gift or gift in p


def _is_wildcard(rule: dict) -> bool:
    for m in (rule.get("match") or []):
        if _norm(m) in ("*", "default", "默认", "其它", "其他"):
            return True
    return False


def _has_over(rule: dict) -> bool:
    return rule.get("over") not in (None, "")


def rules(cfg: dict) -> list[dict]:
    """合并用户规则 + 默认兜底规则，并保证兜底永远排在最后。

    控制台保存时曾经把「≥¥100 → 躺沙发」这类带 over 的规则压成裸 *，
    一旦它排到前面就会把后面所有礼物截胡（跑车/火锅/啤酒全变同一个动作）。
    所以这里再做一次防御：无 over 的通配规则一律沉到队尾。
    """
    gcfg = cfg.get("gift_actions") or {}
    raw = gcfg.get("rules")
    items = [r for r in (raw or []) if isinstance(r, dict)]
    if not items:
        items = list(DEFAULT_RULES)
    else:
        if not any(_is_wildcard(r) for r in items):
            items = items + [DEFAULT_RULES[-1]]
    # 稳定排序：带 over 的、具体关键词的在前；纯通配的最后
    return sorted(items, key=lambda r: (1 if (_is_wildcard(r) and not _has_over(r)) else 0,))


def resolve(gift: str, value: float = 0.0, cfg: dict | None = None) -> dict:
    """按礼物名找规则，返回动作描述。没开动作功能时返回空 dict。"""
    cfg = cfg or {}
    gcfg = cfg.get("gift_actions") or {}
    if gcfg and gcfg.get("enable") is False:
        return {}
    name = _norm(gift)
    for rule in rules(cfg):
        over = rule.get("over")
        if over not in (None, ""):
            try:
                if float(value or 0) < float(over):
                    continue
            except (TypeError, ValueError):
                pass
        patterns = rule.get("match")
        if isinstance(patterns, str):
            patterns = [patterns]
        if not any(_match_one(p, name) for p in (patterns or [])):
            continue
        action = _norm(rule.get("action")) or "bow"
        preset = ACTION_PRESETS.get(action, ACTION_PRESETS["bow"])
        # 优先级：单条规则里写的 > 全局 actions 覆盖 > 内置预设
        eff = action_config(cfg).get(action) or {}
        fx = _norm(rule.get("fx")) or eff.get("fx") or preset["fx"]
        if fx not in _FX_ALLOWED:
            fx = preset["fx"]
        emotion = _norm(rule.get("emotion")) or eff.get("emotion") or preset["emotion"]
        gif = _norm(rule.get("gif")) or eff.get("gif") or preset["gif"]
        hold = _clamp_hold(rule.get("hold"), eff.get("hold") or DEFAULT_HOLD)
        lines = rule.get("lines") or ([rule["line"]] if rule.get("line") else [])
        if isinstance(lines, str):
            lines = [lines]
        return {
            "action": action,
            "fx": fx,
            "emotion": emotion,
            "gif": gif,
            "hold": hold,
            "lines": [str(x) for x in lines if str(x).strip()],
            "song": rule.get("song"),
            "rule": rule.get("name") or action,
        }
    return {}


def render(line: str, user: str, gift: str, count: int = 1, value: float = 0.0,
           boss: str = "") -> str:
    total = f"{gift}×{count}" if count and count > 1 else gift
    boss = boss or random.choice(HONORIFICS)
    try:
        return line.format(user=user, gift=total, raw_gift=gift, count=count,
                           value=f"{value:.1f}", boss=boss)
    except (KeyError, IndexError, ValueError):
        return line


def line_for(action: dict, user: str, gift: str, count: int = 1,
             value: float = 0.0, boss: str = "") -> str:
    lines = (action or {}).get("lines") or []
    if not lines:
        return ""
    return render(random.choice(lines), user, gift, count, value, boss=boss)


def catalog(cfg: dict | None = None) -> list[dict]:
    """给控制台看的动作清单（带中文名 + 说明 + 最终生效的动图和停留时长）。"""
    eff = action_config(cfg)
    out = []
    for key, preset in ACTION_PRESETS.items():
        label, desc = ACTION_LABELS.get(key, (key, ""))
        row = eff.get(key) or {}
        out.append({
            "action": key,
            "label": label,
            "desc": desc,
            "gif": row.get("gif") or preset.get("gif", ""),
            "hold": row.get("hold", DEFAULT_HOLD),
            "emotion": row.get("emotion") or preset.get("emotion", ""),
            "fx": row.get("fx") or preset.get("fx", ""),
            "fx_label": FX_LABELS.get(row.get("fx") or preset.get("fx", ""), ""),
            "default_gif": preset.get("gif", ""),
        })
    return out


def gif_status(gifs_dir=None, cfg: dict | None = None) -> dict:
    """动图素材到位情况：哪些还能用、哪些还在等 GIF。"""
    from .paths import GIFS_DIR
    base = gifs_dir or GIFS_DIR
    try:
        # _small 是控制台预览用的缩略图，舞台不用，别混进来
        have = {p.stem for p in base.glob("*.gif") if not p.stem.endswith("_small")}
    except OSError:
        have = set()
    eff = action_config(cfg)
    rows = []
    for key, preset in ACTION_PRESETS.items():
        name = (eff.get(key) or {}).get("gif") or preset.get("gif", "")
        label = ACTION_LABELS.get(key, (key, ""))[0]
        rows.append({"action": key, "label": label, "gif": name, "ready": name in have})
    return {"dir": str(base), "files": sorted(have),
            "missing": [r["gif"] for r in rows if not r["ready"]], "rows": rows}


# 万一用户又把文件删了，舞台按这张表回退（与 web/stage.js 的 GIF_FALLBACK 保持一致）
GIF_FALLBACK = {
    "whale_crying": "whale_mischievous",
    "whale_cooking": "whale_eating",
    "whale_coding": "whale_happy",
    "whale_tv": "whale_walking",
    "whale_unhappy": "whale_mischievous",
}

DEFAULT_HOLD = 6.0          # 动作动图默认停留秒数
MAX_HOLD = 60.0

# 直播画面上「刷礼菜单」默认展示哪些礼物——只放 4~5 个，一眼看懂、各有各的动作。
#   小心心 → 敲代码   玫瑰 → 比心   大啤酒 → 大哭
#   生日蛋糕 → 做饭   跑车 → 躺沙发看电视
DEFAULT_MENU = [
    "小心心", "玫瑰", "大啤酒", "生日蛋糕", "跑车",
]


# ---------------------------------------------------------------- 动作可配置项
# settings.json 里可以按动作覆盖，不用改代码：
#   "gift_actions": {
#     "default_hold": 6,
#     "actions": {
#       "sofa": {"gif": "my_sofa", "hold": 12, "fx": "notes"},
#       "cry":  {"gif": "whale_crying", "hold": 4}
#     }
#   }

def _action_overrides(cfg: dict | None) -> dict:
    raw = ((cfg or {}).get("gift_actions") or {}).get("actions") or {}
    return raw if isinstance(raw, dict) else {}


def action_config(cfg: dict | None = None) -> dict[str, dict]:
    """动作 → 最终生效的 {gif, fx, emotion, hold}（内置预设 + 用户覆盖）。"""
    cfg = cfg or {}
    gcfg = cfg.get("gift_actions") or {}
    default_hold = _clamp_hold(gcfg.get("default_hold"), DEFAULT_HOLD)
    overrides = _action_overrides(cfg)
    out: dict[str, dict] = {}
    for key, preset in ACTION_PRESETS.items():
        row = {
            "gif": preset.get("gif", ""),
            "fx": preset.get("fx", ""),
            "emotion": preset.get("emotion", ""),
            "hold": default_hold,
        }
        user = overrides.get(key)
        if isinstance(user, dict):
            if _norm(user.get("gif")):
                row["gif"] = _norm(user["gif"])
            if _norm(user.get("fx")):
                row["fx"] = _norm(user["fx"])
            if _norm(user.get("emotion")):
                row["emotion"] = _norm(user["emotion"])
            if user.get("hold") not in (None, ""):
                row["hold"] = _clamp_hold(user.get("hold"), default_hold)
        out[key] = row
    return out


def available_gifs(gifs_dir=None) -> list[dict]:
    """gifs/ 目录里所有能用的动图（供控制台下拉选择，用户可以放自己的图）。"""
    from .paths import GIFS_DIR
    base = gifs_dir or GIFS_DIR
    out: list[dict] = []
    try:
        files = sorted(base.glob("*.gif"))
    except OSError:
        files = []
    for f in files:
        if f.stem.endswith("_small"):
            continue          # 缩略图不参与选择
        has_webp = (base / "stage" / f"{f.stem}.webp").is_file()
        out.append({"name": f.stem, "gif": f.name, "webp": has_webp,
                    "bytes": f.stat().st_size})
    return out


def set_action_override(cfg_patch: dict, action: str, **fields) -> dict:
    """给控制台用：在 gift_actions.actions 里写一个动作的覆盖值。"""
    actions = dict((cfg_patch.get("gift_actions") or {}).get("actions") or {})
    row = dict(actions.get(action) or {})
    for k, v in fields.items():
        if k == "hold":
            if v in (None, ""):
                row.pop("hold", None)
            else:
                row["hold"] = _clamp_hold(v, DEFAULT_HOLD)
        else:
            text = _norm(v)
            if text:
                row[k] = text
            else:
                row.pop(k, None)
    if row:
        actions[action] = row
    else:
        actions.pop(action, None)
    return {"gift_actions": {"actions": actions}}


def _clamp_hold(value, fallback: float) -> float:
    """停留时长兜底：非法 / 0 / 负数 → 用 fallback；上限 MAX_HOLD。"""
    try:
        v = float(value)
    except (TypeError, ValueError):
        return float(fallback)
    if v <= 0:
        return float(fallback)
    return round(min(MAX_HOLD, max(1.0, v)), 1)


def menu_names(cfg: dict | None = None) -> list[str]:
    """画面上「刷礼菜单」要展示的礼物名（可配置）。

    没配 / 配的不是数组 → 用内置默认 5 个；
    显式配成 [] → 表示不要这张菜单（舞台会整块隐藏）。
    """
    gcfg = (cfg or {}).get("gift_actions") or {}
    if "menu" in gcfg and isinstance(gcfg.get("menu"), list):
        return [str(x).strip() for x in gcfg["menu"] if str(x).strip()][:12]
    return list(DEFAULT_MENU)


def menu(cfg: dict | None = None) -> list[dict]:
    """刷礼菜单：每个礼物 → 图标 / 抖币 / 折合 / 实际会触发的动作。

    动作是用 resolve() 现场算的，和真正送礼时走的是同一套规则，
    所以画面上写什么、鲸鱼就演什么，不会两套逻辑。
    """
    from . import gifts as gift_registry
    cfg = cfg or {}
    out: list[dict] = []
    for name in menu_names(cfg):
        row = gift_registry.lookup(name) or {}
        cny = float(row.get("cny") or 0)
        action = resolve(name, cny, cfg) or {}
        label, desc = ACTION_LABELS.get(action.get("action") or "", ("", ""))
        out.append({
            "name": name,
            "icon": gift_registry.icon_url(row),
            "diamond": int(row.get("diamond") or 0),
            "cny": cny,
            "action": action.get("action") or "",
            "action_label": label,
            "action_desc": desc,
            "gif": action.get("gif") or "",
            "hold": float(action.get("hold") or DEFAULT_HOLD),
        })
    return out