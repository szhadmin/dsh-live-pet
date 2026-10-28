"""大肥鲸的智能体大脑：记忆注入 → 大模型/本地话术 → 情绪 → GIF 动作。"""
from __future__ import annotations

import json
import os
import random
import re
import time
import urllib.error
import urllib.request
from collections import deque

from . import config, harness, memory, tools

# 智能体不可用时的熔断：别让每条弹幕都白等十几秒（没配 Key、中继 503、dsh 起不来时最常见）
_AGENT_FAILS: dict[str, float] = {"count": 0.0, "until": 0.0}
AGENT_COOLDOWN = 120.0
AGENT_STATE_FILE = None      # 延迟到第一次用到时按 paths 解析


def _state_file():
    global AGENT_STATE_FILE
    if AGENT_STATE_FILE is None:
        try:
            from .paths import DATA_DIR
            AGENT_STATE_FILE = DATA_DIR / "agent_state.json"
        except Exception:
            AGENT_STATE_FILE = False
    return AGENT_STATE_FILE


def _load_state() -> None:
    path = _state_file()
    if not path:
        return
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        _AGENT_FAILS["count"] = float(data.get("fails") or 0)
        _AGENT_FAILS["until"] = float(data.get("until") or 0)
    except (OSError, ValueError, TypeError):
        pass


def _save_state() -> None:
    path = _state_file()
    if not path:
        return
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"fails": _AGENT_FAILS["count"],
                                    "until": _AGENT_FAILS["until"]}, ensure_ascii=False),
                        encoding="utf-8")
    except OSError:
        pass


_load_state()


def _agent_key(cfg: dict) -> str:
    """快模型用的 Key：顶层没有就复用智能体的那把（否则非提问弹幕会掉进本地话术）。"""
    hcfg = cfg.get("harness") or {}
    return (hcfg.get("api_key") or "").strip() or (cfg.get("api_key") or "").strip()


def _agent_base(cfg: dict) -> tuple[str, str]:
    """快模型用的 (base_url, model)：智能体配了就用智能体的，保证两路走同一个中转。"""
    hcfg = cfg.get("harness") or {}
    base = (hcfg.get("base_url") or "").strip() or str(cfg.get("base_url") or "").strip()
    model = (hcfg.get("model") or "").strip() or str(cfg.get("model") or "").strip()
    return base, model


def _agent_ready(cfg: dict) -> bool:
    hcfg = cfg.get("harness") or {}
    if not hcfg.get("enable"):
        return False
    if time.time() < _AGENT_FAILS["until"]:
        return False
    if not harness.status(cfg).get("available"):
        return False
    key = (hcfg.get("api_key") or cfg.get("api_key") or "").strip()
    if key:
        return True
    env = (hcfg.get("api_key_env") or "BUDDYHUB_API_KEY").strip()
    return bool(os.environ.get(env))


def _agent_failed(reason: str, force: bool = False) -> None:
    """连续失败 2 次就熔断 2 分钟；结构性错误 / force 直接熔断。

    「busy」是上一条弹幕还在思考、抢锁没抢到——不是智能体坏了，绝不能算失败，
    否则礼物答谢撞上一次思考中的弹幕，就把整场打回本地话术两分钟。
    """
    if reason == "busy":
        return
    _AGENT_FAILS["count"] = float(_AGENT_FAILS.get("count") or 0) + 1
    if (force or _AGENT_FAILS["count"] >= 2
            or reason in ("unavailable", "profile", "spawn", "turn")):
        _AGENT_FAILS["until"] = time.time() + AGENT_COOLDOWN
    _save_state()


def _agent_ok() -> None:
    _AGENT_FAILS["count"] = 0.0
    _AGENT_FAILS["until"] = 0.0
    _save_state()


def agent_state() -> dict:
    left = max(0.0, _AGENT_FAILS["until"] - time.time())
    return {"fails": int(_AGENT_FAILS["count"]), "cooldown_left": round(left, 1)}


def reset_agent_state() -> None:
    """配好模型后点「重置会话」会一起清掉熔断，不用等 2 分钟。"""
    _AGENT_FAILS["count"] = 0.0
    _AGENT_FAILS["until"] = 0.0
    _save_state()

EMOTIONS = {
    "happy": "whale_happy",
    "mischievous": "whale_mischievous",
    "eating": "whale_eating",
    "calm": "whale_walking",
    # 礼物动作专用
    "cry": "whale_crying",
    "cook": "whale_cooking",
    "code": "whale_coding",
    "sad": "whale_unhappy",
    "sofa": "whale_tv",
}

EMOTION_WORDS = {
    "happy": ("开心", "高兴", "喜欢", "哈哈", "好耶", "谢谢", "太棒", "可爱", "爱了", "哈哈"),
    "mischievous": ("坏", "调皮", "偷", "悄悄", "嘿嘿", "捉弄", "整", "坏笑", "逗"),
    "eating": ("吃", "饭", "饿", "外卖", "泡面", "宵夜", "奶茶", "蛋糕", "火锅", "干饭"),
}

RULES_TEXT = (
    "你就是个真人主播，坐在镜头前跟人唠嗑，不是客服、不是助手、不是念稿的。"
    "只回应这一条弹幕：一般 15~45 个字。长短要乱：有时三个字「行啊」「真的假的」，有时三十个字，别每句一样长。"
    "带语气词和停顿——啊、呀、诶、哎哟、哈哈、你说呢、我跟你讲；口语可以带点语病，别工整得像作文。"
    "先接住对方的情绪或话头，再说你自己的反应，别一上来就总结。"
    "每句换个开头，别老用「收到」「好的」「这个」「确实」；也别每句都反问。"
    "禁止书面腔：不要「首先/其次/总之/总的来说/值得一提的是/希望对你有帮助」，不要分点、不要编号。"
    "不要 Markdown、不要列表、不要括号旁白、表情符号最多一个。"
    "记忆里有这位观众的信息，就自然带一句（最多一句，别背课文）；没记住就当新朋友处。"
    "不承诺收益、不聊政治、不涉黄、不引导私下交易；别自称 AI、模型、助手、机器人。"
)

# 客服腔 / 书面腔 → 人话（模型偶尔还是会漏出来）
HUMANIZE = (
    (r"^(?:当然|没问题|好的|好呀|收到|明白了|了解)[，,、。！!\s]+", ""),
    (r"需要注意的是[，,]?", "对了，"),
    (r"总的来说[，,]?", "反正"),
    (r"总而言之[，,]?", "反正"),
    (r"首先[，,]?", "先说，"),
    (r"其次[，,]?", "然后，"),
    (r"希望对你有帮助[。！!]?", ""),
    (r"值得一提的是[，,]?", "对了，"),
    (r"建议您", "你不如"),
    (r"您可以", "你能"),
    (r"非常(?:感谢|谢谢)", "谢谢"),
    (r"请问", "问一下"),
    (r"需要注意的是", "对了"),
)


# ---------------------------------------------------------------- 大模型调用

def chat_completion(messages: list[dict], cfg: dict, temperature: float = 0.85,
                    max_tokens: int = 220, json_mode: bool = False, timeout: int = 45,
                    reasoning_effort: str | None = None) -> dict:
    if json_mode:
        max_tokens = max(max_tokens, 420)   # JSON 里还要塞 remember[]，给足余量免截断
    # 顶层没配 Key 时复用智能体的那把（控制台只填一个 Key 也能走快模型通道）
    base = (cfg.get("base_url") or "").rstrip("/")
    key = (cfg.get("api_key") or "").strip()
    model = cfg.get("model")
    if not key or not base:
        hbase, hmodel = _agent_base(cfg)
        key = key or _agent_key(cfg)
        base = base or hbase.rstrip("/")
        model = model or hmodel
    body = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": False,
    }
    # 思考型模型（deepseek-v4.1 系列）会把 max_tokens 全烧在思维链上、
    # 正文回空 → 直播就掉进本地话术。默认关掉推理，正文才稳定。
    effort = cfg.get("reasoning_effort", "none") if reasoning_effort is None else reasoning_effort
    if effort:
        body["reasoning_effort"] = effort
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        base + "/chat/completions",
        data=data,
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + key},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", errors="replace")
        except Exception:
            pass
        # 有些中转站不认 reasoning_effort，直接 400；去掉这个字段再来一次
        if exc.code == 400 and "reasoning" in detail.lower() and "reasoning_effort" in body:
            body.pop("reasoning_effort", None)
            req = urllib.request.Request(
                base + "/chat/completions",
                data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
                headers={"Content-Type": "application/json",
                         "Authorization": "Bearer " + key},
            )
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.load(resp)
        raise


def _pick_emotion(text: str, default: str = "calm") -> str:
    for name, words in EMOTION_WORDS.items():
        if any(w in text for w in words):
            return name
    return default


def _norm_emotion(value: str) -> str:
    v = (value or "").strip().lower()
    alias = {
        "happy": "happy", "joy": "happy", "开心": "happy", "高兴": "happy",
        "mischievous": "mischievous", "playful": "mischievous", "调皮": "mischievous",
        "eating": "eating", "hungry": "eating", "吃": "eating", "干饭": "eating",
        "calm": "calm", "neutral": "calm", "平静": "calm", "温柔": "calm",
    }
    return alias.get(v, "calm")


# ---------------------------------------------------------------- 记忆格式化

def format_memory(ctx: dict, cfg: dict) -> str:
    host = cfg["host"]["name"]
    lines = [f"【关于观众「{ctx['user']}」】"]
    profile = ctx.get("profile") or {}
    if profile:
        lines.append(f"第 {profile.get('msg_count', 1)} 次互动，{ctx.get('seen_days', 0)} 天前第一次来。")
    else:
        lines.append("第一次见面的新观众。")
    if ctx["facts"]:
        lines.append("已记住的信息：")
        lines.extend(f"- {f}" for f in ctx["facts"])
    else:
        lines.append("已记住的信息：暂无。")
    if ctx["turns"]:
        lines.append("最近的对话：")
        for t in ctx["turns"][-6:]:
            who = ctx["user"] if t["role"] == "user" else host
            lines.append(f"{who}：{t['content'][:80]}")
    if ctx.get("highlights"):
        lines.append("【直播间最近发生的事】")
        lines.extend(f"- {h}" for h in ctx["highlights"])
    return "\n".join(lines)


def format_stats(stats: dict | None) -> str:
    """本场数据 → 一段模型能直接引用的「战报」。"""
    if not stats:
        return ""
    tokens = int(stats.get("tokens") or 0)
    tin = int(stats.get("input_tokens") or 0)
    tout = int(stats.get("output_tokens") or 0)
    gifts = int(stats.get("gifts") or 0)
    money = float(stats.get("gift_value") or 0)
    req = int(stats.get("requests") or 0)
    up = int(stats.get("uptime") or 0)
    price = float(stats.get("price_per_million") or 2.0)
    cost = tokens / 1_000_000 * price
    hours, mins = up // 3600, (up % 3600) // 60
    span = f"{hours} 小时 {mins} 分钟" if hours else f"{mins} 分钟"
    last = stats.get("last_gift") or ""
    net = max(0.0, money - cost)      # 礼物少的时候别报「净赚 -0.35」，念出来很怪
    if money >= cost:
        money_line = f"｜扣掉电费净赚约 ¥{net:.2f}\n"
    else:
        money_line = f"｜礼物还没抵上电费，还差约 ¥{cost - money:.2f} 才回本\n"
    return (
        f"【本场工位战报（真实数字，可以直接引用，别说查不到）】\n"
        f"已播 {span}｜回复 {req} 条｜烧掉 {tokens:,} token（输入 {tin:,} / 输出 {tout:,}，"
        f"按 ¥{price:.1f}/百万 折算约 ¥{cost:.2f}）\n"
        f"收到 {gifts} 次礼物，共 ¥{money:.1f}"
        + (f"（最近一次：{last}）" if last else "")
        + money_line
        + f"观众问起 token、成本、收入、礼物、KPI 时，用这些真实数字回答；"
        f"没人问就别硬报账，最多拿来开个玩笑。"
    )


def build_messages(ctx: dict, text: str, cfg: dict, tool_note: str = "",
                   stats: dict | None = None) -> list[dict]:
    system = (
        f"{config.persona_text(cfg)}\n"
        f"你现在正在抖音直播间，昵称「{cfg['host']['name']}」，直播间叫「{cfg['host']['title']}」。\n"
        f"{RULES_TEXT}\n"
        "输出严格 JSON：{\"reply\":\"回复正文\",\"emotion\":\"happy|mischievous|eating|calm\","
        "\"remember\":[\"值得长期记住的观众个人信息，最多2条，没有就空数组\"]}"
    )
    msgs = [
        {"role": "system", "content": system},
        {"role": "system", "content": format_memory(ctx, cfg)},
    ]
    report = format_stats(stats)
    if report:
        msgs.append({"role": "system", "content": report})
    if tool_note:
        msgs.append({"role": "system", "content":
                     "【实时数据】这是刚刚用工具查到的真实数据，回答时直接用它，"
                     "不要说查不到、也不要说自己是AI无法获取：\n" + tool_note})
    msgs.append({"role": "user", "content": text[:300]})
    return msgs


# ---------------------------------------------------------------- 事实抽取（本地）

FACT_PATTERNS = [
    (re.compile(r"我(?:叫|是|名字叫|名字是)\s*([\u4e00-\u9fa5A-Za-z0-9_]{1,12})"), "名字是{0}"),
    (re.compile(r"我(?:今年)?\s*(\d{1,2})\s*岁"), "今年{0}岁"),
    (re.compile(r"我(?:来自|老家在|家在)\s*([\u4e00-\u9fa5]{2,10})"), "来自{0}"),
    (re.compile(r"我在\s*([\u4e00-\u9fa5A-Za-z]{2,12})\s*(?:上班|工作|读书|上学|念书)"), "在{0}工作/上学"),
    (re.compile(r"我(?:喜欢|最爱|爱|粉)\s*([\u4e00-\u9fa5A-Za-z0-9]{1,14})"), "喜欢{0}"),
    (re.compile(r"我(?:讨厌|不喜欢|怕)\s*([\u4e00-\u9fa5A-Za-z0-9]{1,14})"), "不喜欢{0}"),
    (re.compile(r"我(?:养了|养着)\s*([\u4e00-\u9fa5A-Za-z0-9]{1,12})"), "养了{0}"),
    (re.compile(r"我(?:在|正在)(?:学|做|准备)\s*([\u4e00-\u9fa5A-Za-z0-9]{2,16})"), "正在{0}"),
    (re.compile(r"我(?:的)?生日(?:是)?\s*([0-9]{1,2}\s*月\s*[0-9]{1,2}\s*[日号])"), "生日是{0}"),
    (re.compile(r"记住[，,:：]?\s*(.{2,40})"), "记下了：{0}"),
]


BAD_VALUE_WORDS = ("什么", "啥", "谁", "哪", "吗", "呢", "你", "他", "她", "怎么", "多少", "几", "不知道")


def _valid_value(value: str) -> bool:
    if len(value) < 2:
        return False
    if any(b in value for b in BAD_VALUE_WORDS):
        return False
    return True


def extract_facts(text: str) -> list[str]:
    text = (text or "").strip()
    if text.endswith("？") or text.endswith("?") or "吗" in text:
        return []          # 问句不当作事实
    found: list[str] = []
    for pattern, template in FACT_PATTERNS:
        for m in pattern.finditer(text):
            value = m.group(1).strip("，。！？,.!? ")
            if not _valid_value(value):
                continue
            fact = template.format(value)
            if fact not in found:
                found.append(fact)
            if len(found) >= 3:
                return found
    return found


def _fact_dup(new: str, existing: list[str]) -> bool:
    """两条事实说的是同一件事就算重复：「在杭州上班」⊂「在杭州工作」。"""
    a = memory.normalize(new)
    if not a:
        return True
    for old in existing:
        b = memory.normalize(old)
        if not b:
            continue
        if a == b or a in b or b in a:
            return True
        # 去掉「上班 / 工作 / 上学 / 读书」这类同义后缀再比一次
        sa = re.sub(r"(上班|工作|读书|上学|念书|干活)$", "", a)
        sb = re.sub(r"(上班|工作|读书|上学|念书|干活)$", "", b)
        if sa and sa == sb:
            return True
    return False


def _merge_facts(primary: list[str], extra: list[str]) -> list[str]:
    """模型给的 facts 优先，正则抽的只补模型漏掉的，且不让两条说同一件事。"""
    out: list[str] = []
    for f in list(primary or []) + list(extra or []):
        f = str(f or "").strip()
        if not f:
            continue
        if _fact_dup(f, out):
            continue
        out.append(f)
        if len(out) >= 4:
            break
    return out


def store_facts(user: str, facts: list[str]) -> list[str]:
    stored = []
    known = [f["text"] for f in memory.all_facts(user, 120)]
    for f in facts[:3]:
        f = (f or "").strip()
        if not f or _fact_dup(f, known + stored):
            continue
        if memory.add_fact(user, f, kind="fact", weight=1.2):
            stored.append(f)
            memory.add_highlight(user, f"{user} {f}")
    return stored


# ---------------------------------------------------------------- 本地兜底大脑

LOCAL_RULES = [
    (("你是谁", "名字", "介绍"), "我是大肥鲸，深海工位 0001 号打工人，白天写代码，晚上开着这场直播继续写。你说的话我都记在小本本上。", "happy"),
    (("笑话", "搞笑", "开心"), "为什么程序员分不清万圣节和圣诞节？因为 OCT 31 等于 DEC 25。冷吧？我天天活在 bug 里，更冷。", "mischievous"),
    (("吃", "饭", "饿", "零食"), "刚扒了两口饭就被拉去改需求，饭还凉着。你也别老熬夜，真的会秃。", "eating"),
    (("唱歌", "歌"), "我不会唱歌，但键盘有声：哒哒哒、哒哒哒，编译过了那段就是副歌。", "happy"),
    (("记得", "记忆", "上次", "昨天"), "记得，我把每位观众说过的话都存在本地 sqlite 里，翻一下就想起来了。", "calm"),
    (("抖音", "直播", "开播"), "这画面是 OBS 抓我的工位窗口，你发的弹幕会实时变成我的回答，慢一点但不会漏。", "calm"),
    (("token", "Token", "赚钱", "成本"), "Token 是我这行的电费。面板上那串数字，就是这场直播真烧掉了多少，看一次心疼一次。", "calm"),
    (("晚安", "再见", "下班"), "下班？我们这行只有「明天再说」。你先撤，我盯着日志。", "happy"),
    (("喜欢", "爱"), "被喜欢的感觉，比编译一次通过还爽。我记下了，下次见面先喊你的名字。", "happy"),
]

LOCAL_OPENERS = ["收到收到！", "嗯嗯，我在听～", "这个我熟！", "你这一说我想起来了，", "咕噜咕噜，"]


def _local_reply(user: str, text: str, ctx: dict, cfg: dict,
                 fresh_facts: list[str] | None = None,
                 tool_note: str = "") -> tuple[str, str]:
    host = cfg["host"]["name"]
    emotion = _pick_emotion(text)
    ack = ""
    if fresh_facts:
        ack = f"（记下了：{fresh_facts[0]}）"
    if tool_note:
        return ack + f"我查了一下，{tool_note}。这数据是刚捞上来的，还带着海水味呢。", "happy"
    asks_memory = any(k in text for k in ("记得我", "我叫什么", "我是谁", "还记得", "上次", "昨天", "记忆"))
    if asks_memory and ctx["facts"]:
        facts = "、".join(ctx["facts"][:3])
        return f"当然记得！你{facts}。这些我都记在小本本里，翻一下就出来了。", "happy"
    if asks_memory and not ctx["facts"]:
        return (f"咱们好像还是第一次说话，你先把名字告诉我，"
                f"我记在便签本上，下次一开口就认得你。"), "calm"
    for keys, reply, emo in LOCAL_RULES:
        if any(k in text for k in keys):
            if ctx["facts"] and random.random() < 0.6:
                reply = f"（我还记得你{ctx['facts'][0]}）" + reply
            return ack + reply, emo
    if fresh_facts:
        return (f"{ack}工位便签本又厚了一页，以后我就知道你是{user}了。"
                f"今天还聊点别的吗？"), emotion
    if ctx["facts"]:
        hook = ctx["facts"][0]
        return f"{user}，你说「{text[:18]}」这句我收好了。我还记着你{hook}呢，今天过得怎么样？", emotion
    if ctx["is_returning"]:
        return f"{user}又回来啦！刚才你说「{text[:18]}」，我一直在想怎么答你——你觉得呢？", emotion
    return (f"{random.choice(LOCAL_OPENERS)}「{text[:20]}」这句话我记在小本本上了。"
            f"{host}今天陪你聊到底，还想问点啥？"), emotion


# ---------------------------------------------------------------- 主入口

def _room_key(cfg: dict) -> str:
    room = ((cfg.get("douyin") or {}).get("room_id") or "").strip()
    return "room:" + (room or "local")


def _tidy_agent_reply(text: str, max_chars: int = 70) -> str:
    """智能体回的可能带「大肥鲸：」「（……）」之类，收拾成一句能念的台词。

    「本鲸」是旧人设的自称，统一换成「我」——口播 / 冷场 / 礼物答谢都走这里，
    所以在这一层做，保证每条出口都干净。
    """
    text = re.sub(r"^\s*(?:大肥鲸|鲸宝|主播)\s*[:：]\s*", "", str(text or ""))
    text = re.sub(r"```[a-zA-Z]*", "", text).replace("`", "")
    text = text.replace("本鲸", "我")
    text = re.sub(r"我{2,}", "我", text)
    text = re.sub(r"\s+", " ", text).strip().strip('"“”「」\'')
    if len(text) > max_chars:
        cut = text[:max_chars]
        for sep in ("。", "！", "？", "，", "～", "~"):
            pos = cut.rfind(sep)
            if pos >= max_chars * 0.6:
                return cut[:pos + 1]
        return cut.rstrip("，、, ") + "…"
    return text


def humanize(text: str, cfg: dict | None = None) -> str:
    """把模型漏出来的客服腔 / 书面腔揉回人话，再按配置撒一点口癖。"""
    text = (text or "").strip()
    if not text:
        return text
    for pattern, repl in HUMANIZE:
        new = re.sub(pattern, repl, text)
        # 削头别把整句削残：「好的，那我把这个改一下」削完只剩半句就别削
        if pattern.startswith("^") and len(new.strip()) < max(4, len(text) * 0.6):
            continue
        text = new
    text = text.replace("。。", "。").replace("，，", "，").replace("！！", "！")
    text = re.sub(r"\s+", " ", text).strip()
    text = text.replace("本鲸", "我")          # 内置人设自称「我」，别留旧习惯
    # 内置默认人设自带说话方式，不再叠旧口癖（否则会冒出「么西么西」这种串味）
    if not str((cfg or {}).get("persona") or "").strip():
        return text
    quirks = harness._sanitize_quirks(((cfg or {}).get("harness") or {}).get("quirks"))
    if quirks and random.random() < 0.35 and not any(q in text[:4] for q in quirks):
        if random.random() < 0.5:
            text = random.choice(quirks) + "，" + text
        else:
            text = text.rstrip("。！？!?") + "，" + random.choice(quirks) + "。"
    return text


def _agent_reply(user: str, text: str, cfg: dict, ctx: dict, tool_note: str,
                 stats: dict | None = None):
    """让本机 harness 智能体回一句；不可用/超时/报错都返回 None。"""
    hcfg = cfg.get("harness") or {}
    profile = None
    effort = "off"
    # 直播里等太久还不如先用快模型顶上：上限压到 12 秒
    timeout = min(12.0, float(hcfg.get("timeout") or 20))
    if hcfg.get("deep") and harness.looks_like_question(text):
        profile = hcfg.get("deep_profile") or "whale-deep"
        effort = "high"
        timeout = float(hcfg.get("deep_timeout") or 45)
    prompt = harness.build_prompt(user, text, cfg, ctx, tool_note, stats=stats)
    res = harness.ask(prompt, cfg, session_key=_room_key(cfg), profile=profile,
                      effort=effort, timeout=timeout)
    if not res.get("ok"):
        _agent_failed(str(res.get("reason") or ""))
        return None
    speech, facts = harness.split_memory(res.get("reply") or "")
    reply = humanize(_tidy_agent_reply(speech, int(hcfg.get("max_chars") or 70)), cfg)
    if not reply:
        return None
    _agent_ok()
    return reply, _pick_emotion(reply), (res.get("usage") or {}), facts


def _model_reply(user: str, text: str, cfg: dict, ctx: dict, tool_note: str,
                 stats: dict | None = None):
    """走兼容 OpenAI 的快模型：先 JSON，空了再纯文本重试一次。"""
    temp = float((cfg.get("harness") or {}).get("temperature") or 0.95)
    data = chat_completion(build_messages(ctx, text, cfg, tool_note, stats=stats), cfg,
                           temperature=temp, json_mode=True)
    payload = _parse_json(data["choices"][0]["message"].get("content") or "")
    reply = (payload.get("reply") or "").strip()
    emotion = _norm_emotion(payload.get("emotion", ""))
    remember = payload.get("remember") or []
    if not reply:
        # 思维链吃光 token / JSON 变形时，退回「只要一句话」的纯文本模式
        fallback = chat_completion(
            build_messages(ctx, text, cfg, tool_note, stats=stats)[:-1]
            + [{"role": "user", "content": text[:300] + "\n（只回一句 20~70 字的口语台词，不要 JSON）"}],
            cfg, max_tokens=260,
        )
        reply = (fallback["choices"][0]["message"].get("content") or "").strip()
        emotion = ""
    if not reply:
        raise ValueError("模型返回空回复")
    return reply, emotion or _pick_emotion(reply), (data.get("usage") or {}), remember


def respond(user: str, text: str, cfg: dict, stats: dict | None = None) -> dict:
    """返回 {reply, emotion, gif, provider, usage, facts_used, new_facts}"""
    ctx = memory.build_context(user, text, cfg)
    facts_used = ctx["facts"]
    provider = "本地话术"
    usage = {"prompt_tokens": 0, "completion_tokens": 0}
    new_facts: list[str] = []
    reply, emotion = "", "calm"
    heuristic = extract_facts(text)
    tool = tools.maybe_run(text, cfg.get("tools") or {})
    tool_note = ""
    if tool and tool.get("ok") and tool.get("speak"):
        tool_note = tool["speak"]

    hcfg = cfg.get("harness") or {}
    want_agent = _agent_ready(cfg) and (
        not hcfg.get("question_only") or harness.looks_like_question(text))
    if want_agent:
        hit = _agent_reply(user, text, cfg, ctx, tool_note, stats)
        if hit:
            reply, emotion, usage, agent_facts = hit
            provider = "Harness 智能体"
            new_facts = store_facts(user, _merge_facts(agent_facts, heuristic))

    # fallback_model 只约束「智能体开着但没出话」的情况；智能体整个关掉时快模型仍是主力
    can_fallback = bool(hcfg.get("fallback_model", True)) or not hcfg.get("enable")
    if not reply and _agent_key(cfg) and can_fallback:
        try:
            reply, emotion, usage, remember = _model_reply(user, text, cfg, ctx, tool_note, stats)
            llm_facts = [str(x)[:80] for x in remember if str(x).strip()] if isinstance(remember, list) else []
            # 模型给的优先，正则只补它漏掉的（以前两条都入库，「在杭州上班」「在杭州工作」并存）
            new_facts = store_facts(user, _merge_facts(llm_facts, heuristic))
            provider = "大模型"
        except Exception as exc:  # 网络/额度/格式问题 → 本地兜底
            reply, emotion = _local_reply(user, text, ctx, cfg, heuristic, tool_note)
            new_facts = store_facts(user, heuristic)
            provider = "本地兜底"
            memory.add_highlight("system", f"大模型调用异常：{str(exc)[:60]}")
    elif not reply:
        reply, emotion = _local_reply(user, text, ctx, cfg, heuristic, tool_note)
        new_facts = store_facts(user, heuristic)

    if not new_facts:
        new_facts = store_facts(user, heuristic)

    reply = humanize(re.sub(r"\s+", " ", reply).strip(), cfg)
    if len(reply) > 140:
        reply = reply[:138] + "…"
    return {
        "reply": reply,
        "emotion": emotion,
        "gif": EMOTIONS.get(emotion, "whale_walking"),
        "tool": ({"name": tool.get("name"), "text": tool.get("text")} if tool and tool.get("ok") else None),
        "provider": provider,
        "usage": {"prompt_tokens": int(usage.get("prompt_tokens", 0) or 0),
                  "completion_tokens": int(usage.get("completion_tokens", 0) or 0)},
        "facts_used": facts_used,
        "new_facts": new_facts,
        "returning": ctx["is_returning"],
    }


def _parse_json(content: str) -> dict:
    content = content.strip()
    if content.startswith("```"):
        content = re.sub(r"^```[a-zA-Z]*\n?|```$", "", content).strip()
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", content, re.S)
        if m:
            try:
                return json.loads(m.group(0))
            except json.JSONDecodeError:
                pass
    # 兜底 1：JSON 被截断（max_tokens 到顶）——直接把 reply 抠出来
    m = re.search(r'"reply"\s*:\s*"((?:[^"\\]|\\.)*)"', content, re.S)
    if m:
        try:
            text = json.loads('"' + m.group(1) + '"')
        except json.JSONDecodeError:
            text = m.group(1)
        text = text.strip()
        if text:
            return {"reply": text, "emotion": _pick_emotion(text), "remember": []}
    # 兜底 2：抠不到就丢掉 JSON 残渣，宁可走本地话术也不要把 JSON 念给观众
    cleaned = re.sub(r'"(reply|emotion|remember|gif|facts_used)"\s*:.*$', "", content, flags=re.S)
    cleaned = re.sub(r"[{}\[\]]", " ", cleaned).strip(" ,:\"")
    if cleaned.startswith('"') or cleaned.count('"') % 2:
        cleaned = ""
    return {"reply": cleaned, "emotion": _pick_emotion(cleaned), "remember": []}


def gift_reply(user: str, gift: str, count: int, cfg: dict, value: float = 0.0,
               action: dict | None = None, stats: dict | None = None) -> dict:
    """礼物答谢：有智能体就让智能体说（带记忆、不套模板），否则用动作台词/模板。"""
    host = cfg["host"]["name"]
    total = f"{gift}×{count}" if count and count > 1 else gift
    memory.add_highlight(user, f"{user} 送出 {total}")
    memory.add_fact(user, f"送过{total}", kind="gift", weight=1.5)
    emotion = (action or {}).get("emotion") or "happy"
    gif = (action or {}).get("gif") or EMOTIONS.get(emotion, EMOTIONS["happy"])
    # 「谢谢金主 / 大佬 / 铁子 / 老板」——每条礼物答谢都随机带一个称呼
    boss = "老板"
    try:
        from .gift_actions import HONORIFICS
        boss = random.choice(HONORIFICS)
    except Exception:
        pass
    action_line = ""
    if action:
        try:
            from .gift_actions import line_for
            action_line = line_for(action, user, gift, count, value, boss=boss)
        except Exception:
            action_line = ""

    reply, provider, usage, facts = "", "礼物模板", {"prompt_tokens": 0, "completion_tokens": 0}, []
    hcfg = cfg.get("harness") or {}
    if _agent_ready(cfg) and hcfg.get("gift_thanks_agent", True):
        try:
            ctx = memory.build_context(user, f"送了我{gift}", cfg)
            prompt = harness.build_gift_prompt(user, gift, count, value, cfg, ctx,
                                               hint=action_line, stats=stats, boss=boss)
            # 答谢要快：直播里等 5 秒不如直接说动作台词
            wait = min(5.0, float(hcfg.get("timeout") or 20))
            res = harness.ask(prompt, cfg, session_key=_room_key(cfg), effort="off",
                              timeout=wait)
            if res.get("ok"):
                speech, _facts = harness.split_memory(res.get("reply") or "")
                got = humanize(_tidy_agent_reply(speech, int(hcfg.get("max_chars") or 70)), cfg)
                if got:
                    reply, provider = got, "Harness 智能体"
                    usage = res.get("usage") or usage
                    _agent_ok()
                else:
                    _agent_failed("empty", force=True)
            else:
                _agent_failed(str(res.get("reason") or ""), force=True)
        except Exception:
            reply = ""

    if not reply:
        if action_line:
            reply = action_line
        else:
            templates = [
                f"{boss}{user}的{total}！本鲸双手接住，这个月的电费有指望了，谢谢谢谢！",
                f"哇，{boss}{user}的{total}！工位当场响起一阵键盘掌声，这波必须记住你。",
                f"收到{boss}{user}的{total}，我把这条写进周报第一行：今天有人给我发工资了。",
                f"{user}的{total}，铁子你这一手太突然了，本鲸尾鳍都翘起来了！",
                f"谢谢老板{user}的{total}！深海工位全体员工（就我一个）给你鞠躬。",
            ]
            reply = random.choice(templates)
    return {"reply": reply, "emotion": emotion, "gif": gif, "provider": provider,
            "usage": {"prompt_tokens": int(usage.get("prompt_tokens", 0) or 0),
                      "completion_tokens": int(usage.get("completion_tokens", 0) or 0)},
            "facts_used": [], "new_facts": facts, "action": action or {}}



# ---------------------------------------------------------------- 进场 / 关注 / 点赞话术池
# 每条都带 {user}；随机取且尽量不复读最近说过的，避免「每次都是一样的」

WELCOME_POOLS = {
    "enter_new": [
        "欢迎{user}进来，工位旁边有空位，自己坐。",
        "哟，{user}来了！正好，帮我看看这段代码为啥跑不通。",
        "{user}进来了，别嫌乱，我这工位就这样，键盘还热着。",
        "欢迎{user}，深海工位 0001 号今天又多一个同组同事。",
        "{user}来啦，先找个地儿坐，我这编译还得转两分钟。",
        "欢迎{user}游进来，小心脚下，地上全是线。",
        "哎哟，{user}到了！正好，陪我盯一会儿进度条。",
        "欢迎{user}，我这儿没什么好招待的，只有一杯凉了的咖啡。",
        "{user}进来啦，别客气，就当自己工位。",
        "欢迎欢迎，{user}——本鲸刚被需求追着跑完一圈，正好歇口气。",
        "{user}来了，今天人不多，正好聊点正经的（不正经的也行）。",
        "欢迎{user}，坐我旁边那个工位吧，显示器还是好的。",
        "{user}游进来了，工位灯有点晃，你将就一下。",
        "哟{user}，来得正好，我这刚敲完一段，正想找人吹两句。",
        "欢迎{user}，别看我胖，我这是深海压强练出来的。",
    ],
    "enter_back": [
        "{user}又游回来啦，我认得你，刚才还想起你说过的话呢。",
        "哎，{user}！你上次来我记着呢，别装新面孔。",
        "{user}回来了，工位给你留着呢，还是老位置。",
        "欢迎回来{user}，我这记性差归差，你的名字可没忘。",
        "{user}又来啦，刚还念叨你呢，说来就来了。",
        "哟{user}，这都第几回了，算你是老同组了。",
        "{user}游回来啦，茶还是凉的，人还是我，聊聊？",
        "欢迎回来{user}，这次想聊点啥，还是先听我吐槽需求？",
    ],
    "follow": [
        "谢谢{user}的关注！以后你就是同组的了，名字我记在工位便签上。",
        "{user}点关注了！本鲸当场把你的名字刻在键盘上（心里那种）。",
        "谢谢{user}关注，从今天起你就是本鲸的正式同组，工号我这儿给你留着。",
        "{user}关注了！深海工位正式工+1，欢迎入组。",
        "谢谢{user}，关注一按，咱俩就是长期合作关系了，比需求文档靠谱。",
        "{user}点了关注，本鲸这尾鳍一摆，算是给你敬个礼。",
        "谢啦{user}，关注我你就等着看我怎么被 bug 折磨吧。",
        "{user}关注成功！以后每天这个点，我都在工位等你。",
        "谢谢{user}的关注，铁子，这份情我记小本本上了。",
        "{user}关注了——本鲸今天的 KPI 有着落了，谢谢谢谢。",
        "谢谢{user}！关注就是给我发工资，虽然发的是鼓励。",
        "{user}关注啦，以后工位旁边永远给你留个座。",
    ],
    "like": [
        "{user}点了个赞！我这尾鳍当场就摆起来了，谢谢你啊。",
        "谢谢{user}的点赞，胖鲸我给你回一个大尾巴甩水花！",
        "收到{user}的赞，我这键盘都敲得更有劲了，谢谢谢谢！",
        "{user}点赞了，本鲸这口气瞬间顺了，继续干活。",
        "谢{user}的赞！这一下比咖啡管用。",
        "{user}一个赞，我能多敲五十行代码，真的。",
        "谢谢{user}，点赞收到，工位风扇都转得欢快了。",
        "{user}点了个赞，本鲸当场给你表演一个原地开心。",
        "谢啦{user}，这点赞比需求变更通知好看多了。",
        "{user}的赞我收到了，铁子够意思。",
        "谢谢{user}！点赞就是我的加班费，虽然只有精神上的。",
        "{user}点赞了——本鲸今天的电费有人分摊了（心理上）。",
    ],
}

_WELCOME_RECENT: deque = deque(maxlen=14)


def _welcome_pick(pool: list[str], user: str) -> str:
    """随机取一条，尽量避开最近说过的，别让观众听出复读。"""
    fresh = [x for x in pool if x not in _WELCOME_RECENT]
    line = random.choice(fresh or pool)
    _WELCOME_RECENT.append(line)
    try:
        return line.format(user=user)
    except (KeyError, IndexError, ValueError):
        return line


def welcome_reply(user: str, kind: str, cfg: dict) -> dict:
    profile = memory.get_user(user)
    returning = bool(profile and profile.get("msg_count", 0) > 1)
    if kind == "follow":
        reply = _welcome_pick(WELCOME_POOLS["follow"], user)
    elif kind == "like":
        reply = _welcome_pick(WELCOME_POOLS["like"], user)
    elif kind == "enter":
        reply = _welcome_pick(WELCOME_POOLS["enter_back" if returning else "enter_new"], user)
    else:
        reply = _welcome_pick(WELCOME_POOLS["enter_back" if returning else "enter_new"], user)
    return {"reply": reply, "emotion": "happy", "gif": EMOTIONS["happy"], "provider": "进场话术",
            "usage": {"prompt_tokens": 0, "completion_tokens": 0}, "facts_used": [], "new_facts": []}


def idle_line(cfg: dict) -> str:
    lines = [
        "工位现在很安静，只有风扇声。来个人说句话，我记性可好了。",
        "我在看编译进度条，已经转了 88 圈了，谁发条弹幕打断我一下。",
        "今天的需求特别离谱，边改边等你们来聊天。",
        "刚才有人问我记不记得他，当然记得，每个人的话我都存在本地库里。",
    ]
    return random.choice(lines)


# ---------------------------------------------------------------- 冷场自己找话题

IDLE_RULES = (
    "现在直播间没人说话，你要自己找话题，像主播救场那样自然开口。"
    "要求：20~60 个汉字，口语化，一条一句话；"
    "可以是问观众一个问题、说说工位正在干什么（写代码 / 等编译 / 改需求）、聊聊刚才某位观众说过的事，"
    "或者报个小日常（被需求追、看 token 账单、修 bug）。"
    "不要 Markdown、不要列表、不要表情符号堆砌、不要自称 AI 或官方；"
    "不要重复上次说过的话；不要催人送礼、不要报数据。"
)

IDLE_FALLBACK = [
    "安静成这样，我这尾鳍都不知道往哪摆。来个人说句话，聊啥都行，我正好等编译。",
    "刚把工位的灯擦了一遍。你们那边现在几点，是不是也在加班？",
    "编译还在转圈，我盯着进度条发呆。有人今晚吃了吗，吃的啥？",
    "我最近在学一件事：记住每个来过的人。你上次来是哪天，我还真记着。",
    "没人说话我就自己念叨——今天需求又改了三版，改到最后跟第一版一样。",
    "刚看到一只小丑鱼从工位旁游过去，比我下班还利索。",
    "问一句啊，你们晚上睡不着的时候干嘛？我一般数 token，数到三万就糊涂了。",
    "这场直播烧的 token 我都能背下来了。谁来陪我聊两句，摊薄一下成本。",
    "有点想念刚才那个说话很逗的朋友了，你们身边有没有这种一开口就想笑的人？",
    "我在琢磨一个老问题：为什么「最后一次改动」永远不是最后一次。",
    "工位的灯有点晃，我调了调——现在好了。你们那边天气怎么样？",
    "不说话也行，我就在这儿敲着。不过要是有人吱一声，我能高兴半天。",
]


def idle_topic(cfg: dict, avoid: list[str] | None = None, hint: str = "",
               stats: dict | None = None) -> dict:
    """冷场时自己找话题：返回 {reply, emotion, provider}。有 Key 走模型，没有就用本地话术。"""
    avoid = [a for a in (avoid or []) if a]
    avoid_text = "\n".join(f"- {a}" for a in avoid[:6]) or "（无）"

    hcfg = cfg.get("harness") or {}
    if _agent_ready(cfg):
        task = (
            "现在直播间没人说话，轮到你自己找话题救场。\n"
            f"{IDLE_RULES}\n"
            + (f"【直播间最近的情况】{hint}\n" if hint else "")
            + (format_stats(stats) + "\n" if stats else "")
            + f"【你刚才已经说过的，别重复】\n{avoid_text}\n"
            "只输出这一句台词，不要解释、不要加引号、不要 JSON。"
        )
        res = harness.ask(task, cfg, session_key=_room_key(cfg),
                          timeout=min(float(hcfg.get("timeout") or 20), 25))
        if res.get("ok"):
            text = _tidy_agent_reply(res.get("reply") or "", int(hcfg.get("max_chars") or 70))
            if 8 <= len(text) <= 120:
                return {"reply": text, "emotion": _pick_emotion(text, "calm"),
                        "provider": "自主发言（智能体）"}

    if cfg.get("api_key"):
        system = (
            f"{config.persona_text(cfg)}\n"
            f"你是抖音直播间「{cfg['host']['title']}」的主播，昵称「{cfg['host']['name']}」。\n"
            f"{IDLE_RULES}\n"
            "只输出这句话本身，不要 JSON、不要解释、不要加引号。"
        )
        msgs = [{"role": "system", "content": system}]
        if hint:
            msgs.append({"role": "system", "content": "【直播间最近的情况】\n" + hint})
        if stats:
            msgs.append({"role": "system", "content": format_stats(stats)})
        msgs.append({"role": "system", "content": "【你已经说过的，别重复】\n" + avoid_text})
        msgs.append({"role": "user", "content": "现在没人说话，你自己找个话题开口吧。"})
        try:
            resp = chat_completion(msgs, cfg, temperature=0.95, max_tokens=160, timeout=20)
            text = (resp["choices"][0]["message"].get("content") or "").strip()
            text = re.sub(r'^["“「]|["”」]$', "", text).strip()
            text = re.sub(r"\s+", " ", text)
            if 8 <= len(text) <= 120:
                return {"reply": text, "emotion": _pick_emotion(text, "calm"), "provider": "自主发言"}
        except Exception:
            pass

    pool = [line for line in IDLE_FALLBACK if line not in avoid] or IDLE_FALLBACK
    text = random.choice(pool)
    return {"reply": text, "emotion": _pick_emotion(text, "calm"), "provider": "自主发言（本地）"}


# ---------------------------------------------------------------- 定时引导（点赞 / 关注 / 小心心）

PROMO_RULES = (
    "现在插一句口播，提醒直播间的观众：点点赞、点点关注、顺手点几个小心心。"
    "要求：25~60 个汉字，一条一句话，像主播随口提一嘴，不像广告；"
    "不要念「点赞、关注、送礼物」三个词连成一串，要说得自然、带点自嘲或好处；"
    "不要 Markdown、不要列表、不要表情符号堆砌、不要自称 AI 或官方；"
    "不要承诺任何好处（返现、抽奖、福利），不要催人花钱。"
)

PROMO_POOL = [
    "顺手的事啊，屏幕右下角那个小心心，点一下我这尾鳍就抖一下。",
    "路过的朋友点个关注呗，关注了下次开播你能第一时间看见我在改 bug。",
    "点赞不要钱，但对我很重要——点一下，我这段代码就少报一个错（心理作用）。",
    "新来的点个关注，老观众点个赞，我这就当你们给我发工资了。",
    "来来来，点赞走一波，我这工位灯有点暗，靠你们的赞照亮。",
    "点关注不花钱，点了以后你就是本鲸的同组同事，工号我给你留着。",
    "小心心扔几个过来，我拿它当夜宵，深海这边真没什么吃的。",
    "刷到这儿别急着划走，点个赞，看我下一段代码能不能一次编译过。",
    "关注一下呗，我这场直播的 KPI 全靠你们的手指头了。",
    "点赞的人今晚不加班，我说的（虽然我说了不算）。",
    "屏幕上的赞越多，我这键盘敲得越快，真的，物理层面的快。",
    "老铁们，小心心点两下，本鲸给你们表演一个原地满血复活。",
    "关注点了没？没点的话现在点一下，我等你，反正编译也在转圈。",
    "点赞是免费的，但对我来说像发工资，你们懂的。",
    "别光看啊，点个赞留个痕迹，让我知道这直播间不是只有我一个人。",
    "小心心、赞、关注，三件套随手来一个，我这场就不算白播。",
    "看到这儿的都是自己人，点个关注，以后我天天在这个工位等你。",
    "点赞的点一下，关注的关注一下，我这边继续敲代码，不耽误。",
]

_PROMO_RECENT: deque = deque(maxlen=10)


def promo_reply(cfg: dict, avoid: list[str] | None = None,
                stats: dict | None = None) -> dict:
    """定时口播：引导点赞 / 关注 / 小心心。有智能体就让它自己说，否则走本地池。"""
    avoid = [a for a in (avoid or []) if a]
    hcfg = cfg.get("harness") or {}
    if _agent_ready(cfg) and (cfg.get("promo") or {}).get("agent", True):
        prompt = harness.build_promo_prompt(cfg, avoid=avoid, stats=stats)
        res = harness.ask(prompt, cfg, session_key=_room_key(cfg), effort="off",
                          timeout=min(8.0, float(hcfg.get("timeout") or 20)))
        if res.get("ok"):
            text = _tidy_agent_reply(res.get("reply") or "", int(hcfg.get("max_chars") or 70))
            if 8 <= len(text) <= 120:
                return {"reply": text, "emotion": _pick_emotion(text, "happy"),
                        "provider": "口播（智能体）",
                        "usage": res.get("usage") or {}}

    pool = [x for x in PROMO_POOL if x not in _PROMO_RECENT and x not in avoid] or PROMO_POOL
    text = random.choice(pool)
    _PROMO_RECENT.append(text)
    return {"reply": text, "emotion": _pick_emotion(text, "happy"), "provider": "口播（本地）",
            "usage": {"prompt_tokens": 0, "completion_tokens": 0}}
