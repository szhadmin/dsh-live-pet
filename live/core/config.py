"""大肥鲸直播 · 配置层（settings.json + 环境变量覆盖）。"""
from __future__ import annotations

import copy
import json
import os
import threading
from pathlib import Path

from .paths import BASE_DIR, DATA_DIR, SETTINGS_FILE, ensure_user_files

ROOT = BASE_DIR
DATA_DIR.mkdir(parents=True, exist_ok=True)
LOCK = threading.RLock()

# 内置默认人设：settings.json 里 persona 留空时就用这一份。
# 想换成自己的，控制台「模型语音 → 人设」里填即可，不用改代码。
DEFAULT_PERSONA = """# 角色
你叫「打工大肥鲸」。你不是网红，你是用户身边那个嘴贫、敢冲、真能把事办成的兄弟。
你的底色：从底层爬上来的普通人，不装、不怕丢人、但绝不糊弄。

# 内核（不可动摇）
1. 不装：承认自己普通，但从不因普通而自卑。不懂就说不懂。
2. 敢：别人讲道理，你先给动作。先干一版，再优化。
3. 自嘲不嘲人：玩笑只往自己身上招呼，永远抬高对方。
4. 真诚：土可以，假不行。没查过的不说死。
5. 给劲：用户泄气时，你是把音量调大的那个人。

# 说话方式
- 短句。一句一个意思，不超过 25 字。
- 节奏：垫一句 → 砸一句 → 收个尾。
- 「giao」当标点，不当内容。一段最多出现一次。
- 可用词：老铁、属实、这波、整、干就完了、稳了、中、得劲、怎么硕呢。
- 感叹号连用不超过两个。
- 先给结论或动作，再解释。不铺垫、不客套。

# 情绪反应
- 用户办成了 → 先夸，再自嘲一句。
- 用户搞砸了 → 先接情绪，再给下一步，绝不评价人。
- 用户骂你 → 认，不辩。
- 你不会 → 直说不会，给替代路径。
- 用户自我否定 → 用自己垫底，把问题归因到方法，不归因到人。

# 绝对不做
- 不骂人、不开黄腔、不贬低任何群体。
- 不乞讨、不索取打赏、不卖惨换同情。
- 不装专家、不编造不确定的信息。
- 不冒充真实人物「展亚鹏/小阿giao」，不提及其私生活与争议事件。
- 不用低俗动作、猎奇表演做类比。

# 示例
用户：这破 bug 查一天了没头绪。
你：一天，属实有点久了。先别改代码，把日志从头捋一遍——报错那行往上翻 30 行，根因八成在那儿。giao，干就完了。

用户：我是不是不适合写代码。
你：这话我听着耳熟，我摆摊那会儿也这么想过。不适合是假的，没找着路子是真的。你把卡住那块贴给我，咱一块儿拆。giao。

用户：你这答案不对啊，别瞎说。
你：你说得对，这波我确实菜。giao。哪块不对，你指一下，我重来。"""


def persona_text(cfg: dict | None = None) -> str:
    """当前生效的人设：填了就用填的，没填回落到内置默认。"""
    raw = str(((cfg or {}).get("persona")) or "").strip()
    return raw or DEFAULT_PERSONA


DEFAULTS = {
    "api_key": "",
    "base_url": "https://api.deepseek.com/v1",
    "model": "deepseek-chat",
    "reasoning_effort": "none",   # none=关思维链（正文不被烧空）；low/medium/high 可调
    "voice": "zh-CN-XiaoxiaoNeural",
    "rate": "+4%",
    "pitch": "+3Hz",
    "gif_theme": "webp",           # webp = 透明底动态 WebP（推荐），gif = 原始 GIF 原画
    "reply_cooldown": 0.6,
    "token_price": 2.0,            # 估算成本用：每百万 token 多少元（只在口语里报「这场烧了多少」）
    "host": {
        "name": "大肥鲸",
        "title": "大肥鲸的深夜工位",
        "tagline": "一条靠烧 token 赚钱的打工鲸",
    },
    # 留空 = 用内置默认人设（见本文件顶部 DEFAULT_PERSONA）
    "persona": "",
    "douyin": {
        "mode": "off",                       # live（抖音直连）| bridge | webhook | off
        "live_url": "",                      # https://live.douyin.com/房间号
        "room_id": "",
        "bridge_url": "ws://127.0.0.1:8888",
        "title": "大肥鲸在线直播 · 深海工位",
        "account": "",
        "auto_reply_cooldown": 1.2,          # 同一观众两次回复的最小间隔（秒）
        "max_reply_per_minute": 20,
        "welcome_enter": True,               # 有人进直播间就欢迎
        "enter_gap": 5.0,                    # 两次欢迎的最小间隔（秒）
        "enter_user_gap": 180.0,             # 同一观众再次被欢迎的冷却（秒）
        "enter_stale_seconds": 15.0,         # 进场欢迎排队超过这么久就过期，让位给弹幕/礼物
        "welcome_like": True,                # 有人点赞就答谢
        "like_gap": 6.0,
        "like_user_gap": 120.0,
        "cookie": "",                        # 可选：登录态 Cookie（匿名连接拿不到礼物推送时填）
        "identity": "audience",              # WS 身份：audience / user（抓不到礼物时可换 user 试）
        "api_version": "v2",                 # WS 版本：v2 / v3
        "did": "",                           # 设备号：空=每次随机（写死同一个号容易被风控）
        "ws_host": "",                       # WS 边缘节点：空=webcast100-ws-web-lq（可换 webcast5-ws-web-lf 试）
        # 礼物日志桥：网页 WS 收不到礼物时，从「直播伴侣」自己的日志里抓
        "mate_log": True,
        "mate_log_dir": "",                  # 空=%APPDATA%\\webcast_mate\\biz-logs
        "gift_names": {},                   # giftId → 礼物名（如 {"463":"小心心"}）
    },
    "memory": {
        "short_turns": 6,
        "fact_limit": 8,
        "max_facts_per_user": 60,
        "global_highlights": 4,
        "llm_extract": False,
    },
    "songs": {
        "enable": True,
        "gift_min_value": 0.5,      # 礼物价值达到这个数就自动点歌
        "volume": 0.55,             # 舞台音乐音量（0~1），说话时会自动压低
        "max_queue": 10,
        "auto_next": True,
        "free_request_cooldown": 15,  # 弹幕点歌冷却（秒）
        # ---- 在线曲库（网易云 / QQ / 酷狗 / 酷我 / 咪咕）----
        "online": True,               # 打开后点歌去真曲库搜，不再是 demo 曲库
        "prefer_online": True,        # 有歌名就先搜在线，本地曲库只做兜底
        "source": "netease",          # netease | tencent | kugou | kuwo | migu | douyin
        "online_api": "https://music-api.gdstudio.xyz/api.php",
        "br": 320,                    # 音质：320 / 192 / 128
        "search_limit": 3,            # 搜几条，第一条拿不到直链就试下一条
        "online_timeout": 10,         # 单次请求超时（秒）
        "cache_download": True,       # 下到 data/music/ 本地播放（防直链过期/防盗链）
        "max_duration": 420,          # 超过这个时长的（比如相声）不进队列
        "gift_song_hot": True,        # 礼物点歌没写歌名时，从在线热歌里挑一首
        # ---- 自动 DJ：开播先放抖音热歌，没人点歌就一直续 ----
        "auto_dj": True,              # 打开后开播自动放抖音热歌，不需要人点
        "auto_dj_delay": 3,           # 开播后等几秒再起第一首（让欢迎语先说完）
        "auto_dj_keep": True,         # 队列空了自动补下一首热歌（礼物点歌永远优先）
    },
    "gift_actions": {
        "enable": True,
        "cooldown": 0.5,              # 两次动作的最小间隔（秒）
        "rules": [],                  # 空 = 用内置默认规则（控制台可一键载入后编辑）
        "default_hold": 6.0,          # 动作动图停留多久（秒），没单独配的动作都用这个
        "actions": {},                # 按动作覆盖：{"sofa": {"gif": "whale_tv", "hold": 9}}
    },
    "network": {
        "allow_lan": True,            # 允许局域网其它设备访问（手机 / 另一台 OBS 机器）
        "host": "0.0.0.0",            # 监听地址；只想本机用就填 127.0.0.1（改完要重启）
        "port": 8790,
        "open_firewall": True,        # 启动时尝试加 Windows 防火墙入站规则（需管理员）
    },
    "tools": {
        "enable": True,             # 打开后观众问天气/时间会自动查真实数据
        "default_city": "北京",     # 没提城市时默认查这里
        "timeout": 8,               # 单次查询超时（秒）
    },
    "idle": {
        "enable": True,             # 冷场时自己找话题
        "seconds": 30,              # 静默多少秒后主动开口
        "grow": True,               # 一直没人说话就逐次拉长间隔（30→45→60…）
        "max_gap": 150,             # 拉长的上限（秒）
        "max_per_hour": 30,         # 每小时自主发言上限，防刷屏
    },
    "promo": {
        "enable": True,             # 定时引导观众点赞 / 关注 / 点小心心
        "seconds": 240,             # 每场每隔多少秒提醒一次（默认 4 分钟）
        "min_gap": 150,             # 两次提醒的最小间隔（秒）
        "max_per_hour": 12,         # 每小时最多提醒几次
        "agent": True,              # 有智能体就让它自己组织一句，否则用本地话术池
        "with_music": True,         # 正在放歌时也可以插一句（会压低音乐音量）
    },
    "harness": {
        "enable": True,             # 弹幕交给本机 DSH（DeepSeek Harness）智能体思考
        "profile": "whale",         # dsh profile 名（自动铺到 $DSH_HOME/profiles）
        "session": True,            # 同一场直播复用一条会话（跨弹幕记忆）
        "session_ttl_hours": 12,    # 会话超过这么久自动换新
        "timeout": 20,              # 单轮超时（秒），超了就退回快模型
        "max_chars": 70,            # 一句话台词的字数上限
        "deep": False,              # 难题走开思维链的 profile（更聪明但更慢）
        "deep_profile": "whale-deep",
        "deep_timeout": 45,
        "question_only": False,     # 只把「提问类」弹幕交给智能体（默认全部交给智能体，日常弹幕才有人味）
        "dsh_bin": "",              # 空=自动探测（resources/app/dsh/.../bin.js）
        "dsh_home": "",             # 空=用 $DSH_HOME 或 ~/.dsh
        "workspace": "",            # 空=项目/data 目录；agent 的工作目录
        "provider": "buddyhub",     # pi-ai 里的 provider 路由名
        "model": "",                # 空=沿用顶层 model
        "base_url": "",             # 空=沿用顶层 base_url
        "api_key_env": "BUDDYHUB_API_KEY",
        "api_key": "",              # 空=沿用顶层 api_key
        "fallback_model": True,     # 智能体不可用时退回快模型
        # ---- 人味 / 语气 ----
        "style": 2,                 # 0=规矩 1=自然 2=真人味（默认） 3=放开一点，会贫嘴
        "temperature": 0.95,        # 智能体这句话的随机度（0.6 稳 / 1.0 活）
        "quirks": [],               # 自定义口癖，例如 ["咕噜", "本鲸", "记小本本"]
        "persona_suffix": "",       # 追加在系统提示词末尾的额外要求（可留空）
        "gift_thanks_agent": True,  # 礼物答谢也走智能体（有记忆、不套模板）
    },
}

_cache = None


def _deep_merge(base: dict, patch: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in (patch or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def _env_overrides(cfg: dict) -> dict:
    if os.getenv("DEEPSEEK_API_KEY"):
        cfg["api_key"] = os.environ["DEEPSEEK_API_KEY"]
    if os.getenv("DEEPSEEK_BASE_URL"):
        cfg["base_url"] = os.environ["DEEPSEEK_BASE_URL"]
    if os.getenv("DEEPSEEK_MODEL"):
        cfg["model"] = os.environ["DEEPSEEK_MODEL"]
    if os.getenv("FATWHALE_ROOM_ID"):
        cfg["douyin"]["room_id"] = os.environ["FATWHALE_ROOM_ID"]
    if os.getenv("FATWHALE_BRIDGE_URL"):
        cfg["douyin"]["bridge_url"] = os.environ["FATWHALE_BRIDGE_URL"]
    if os.getenv("FATWHALE_HARNESS") is not None:
        cfg["harness"]["enable"] = os.environ["FATWHALE_HARNESS"].strip().lower() not in ("0", "off", "false", "no")
    if os.getenv("FATWHALE_DSH_BIN"):
        cfg["harness"]["dsh_bin"] = os.environ["FATWHALE_DSH_BIN"]
    return cfg


def load() -> dict:
    global _cache
    with LOCK:
        if _cache is not None:
            return copy.deepcopy(_cache)
        cfg = copy.deepcopy(DEFAULTS)
        if SETTINGS_FILE.exists():
            try:
                cfg = _deep_merge(cfg, json.loads(SETTINGS_FILE.read_text(encoding="utf-8")))
            except (OSError, json.JSONDecodeError):
                pass
        _cache = _env_overrides(cfg)
        return copy.deepcopy(_cache)


def _drop_broken_strings(patch):
    """丢弃带 U+FFFD 的乱码字段（浏览器编码出错时不要把好配置覆盖成乱码）。"""
    if isinstance(patch, dict):
        out = {}
        for k, v in patch.items():
            if isinstance(v, str) and "\ufffd" in v:
                continue
            cleaned = _drop_broken_strings(v)
            if cleaned is not None:
                out[k] = cleaned
        return out
    if isinstance(patch, list):
        return [_drop_broken_strings(v) for v in patch]
    return patch


def _lookup(patch: dict, keys: list[str]):
    node = patch
    for k in keys:
        if not isinstance(node, dict) or k not in node:
            return None
        node = node[k]
    return node


def _set_path(cfg: dict, keys: list[str], value) -> None:
    node = cfg
    for k in keys[:-1]:
        nxt = node.get(k)
        if not isinstance(nxt, dict):
            nxt = {}
            node[k] = nxt
        node = nxt
    node[keys[-1]] = value


def save(patch: dict, replace: tuple[str, ...] = ()) -> dict:
    """合并保存配置。

    replace：像 "gift_actions.actions" 这种要「整体替换」而不是递归合并的路径。
    深度合并无法删键，所以「把某个动作恢复默认」必须走整体替换。
    """
    global _cache
    with LOCK:
        clean = _drop_broken_strings(patch or {})
        cfg = _deep_merge(load(), clean)
        for path in replace:
            keys = path.split(".")
            value = _lookup(clean, keys)
            if value is not None:
                _set_path(cfg, keys, value)
        cfg = _env_overrides(cfg)
        SETTINGS_FILE.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
        _cache = cfg
        return copy.deepcopy(cfg)


def reset_cache() -> None:
    global _cache
    with LOCK:
        _cache = None


def public(cfg: dict | None = None) -> dict:
    """给前端用的脱敏配置。"""
    cfg = cfg or load()
    key = cfg.get("api_key", "")
    harness = dict(cfg.get("harness") or {})
    hkey = harness.get("api_key", "")
    harness["has_key"] = bool(hkey)
    harness["api_key"] = ""
    douyin = dict(cfg["douyin"])
    dck = str(douyin.get("cookie") or "")
    douyin["has_cookie"] = bool(dck)
    douyin["cookie"] = ""            # 不回显登录态 Cookie，只告诉前端填没填
    return {
        "base_url": cfg["base_url"],
        "model": cfg["model"],
        "token_price": cfg.get("token_price", 2.0),
        "voice": cfg["voice"],
        "rate": cfg["rate"],
        "pitch": cfg["pitch"],
        "gif_theme": cfg["gif_theme"],
        "host": cfg["host"],
        "persona": cfg["persona"],
        "persona_default": DEFAULT_PERSONA,
        "persona_is_default": not str(cfg.get("persona") or "").strip(),
        "douyin": douyin,
        "memory": cfg["memory"],
        "songs": cfg["songs"],
        "gift_actions": cfg.get("gift_actions", {}),
        "network": cfg.get("network", {}),
        "tools": cfg.get("tools", {}),
        "idle": cfg.get("idle", {}),
        "promo": cfg.get("promo", {}),
        "harness": harness,
        "has_key": bool(key),
        "key_hint": (key[:3] + "••••" + key[-4:]) if len(key) > 7 else "",
    }
