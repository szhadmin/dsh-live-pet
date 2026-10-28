"""大肥鲸的「手」：只读信息查询工具集。

已接入（全部免密钥、国内可直连）：
- search   通用网页搜索（360 主、Bing 备），什么都能问一句
- weather  天气（中国天气网：实况 + 今日预报 + 空气质量）
- stock    股票 / 指数行情（腾讯行情）
- fx       人民币汇率（新浪财经）
- lottery  彩票开奖（中国福彩官网）
- ip       IP 归属地（ip-api，中文）
- calc     算式计算
- time / date  时间、日期

设计要点：
1. 不依赖模型支持 function calling —— 关键词先判断意图，真查到数据，
   再把「实时数据」塞进提示词，让模型用鲸鱼口吻说出来。
2. 全部有超时 + 缓存 + 失败降级，直播里不会因为网络卡住整条回复链路。
3. 只查不写：没有任何会改动外部状态的工具。
"""
from __future__ import annotations

import json
import re
import time
import urllib.parse
import urllib.request
from datetime import datetime

UA = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    "Accept-Language": "zh-CN,zh;q=0.9",
}

# 常用城市 → 中国天气网城市编码（没收录的走 search 接口兜底）
CITY_CODES = {
    "北京": "101010100", "上海": "101020100", "天津": "101030100", "重庆": "101040100",
    "哈尔滨": "101050101", "长春": "101060101", "沈阳": "101070101", "大连": "101070201",
    "呼和浩特": "101080101", "石家庄": "101090101", "太原": "101100101", "西安": "101110101",
    "济南": "101120101", "青岛": "101120201", "郑州": "101180101", "南京": "101190101",
    "苏州": "101190401", "无锡": "101190201", "常州": "101191101", "徐州": "101190801",
    "合肥": "101220101", "杭州": "101210101", "宁波": "101210401", "温州": "101210701",
    "绍兴": "101210501", "嘉兴": "101210301", "金华": "101210901", "台州": "101210601",
    "湖州": "101210201", "武汉": "101200101", "长沙": "101250101", "南昌": "101240101",
    "福州": "101230101", "厦门": "101230201", "泉州": "101230501", "广州": "101280101",
    "深圳": "101280601", "珠海": "101280701", "佛山": "101280800", "东莞": "101281601",
    "中山": "101281701", "惠州": "101280301", "南宁": "101300101", "桂林": "101300501",
    "海口": "101310101", "三亚": "101310201", "成都": "101270101", "绵阳": "101270401",
    "贵阳": "101260101", "昆明": "101290101", "拉萨": "101140101", "西宁": "101150101",
    "兰州": "101160101", "银川": "101170101", "乌鲁木齐": "101130101", "香港": "101320101",
    "澳门": "101330101", "台北": "101340101", "烟台": "101120501", "洛阳": "101180901",
    "唐山": "101090501", "保定": "101090201", "大庆": "101050901", "包头": "101080201",
}

STOP_CITY = {"今天", "明天", "后天", "现在", "这里", "那边", "你那", "我这", "天气",
             "气温", "多少", "几度", "最近", "这边", "哪里", "什么", "怎么", "有没有",
             "怎么样", "怎样", "咋样", "如何", "好吗", "好不", "冷不冷", "热不热",
             "不错", "真好", "很好", "一般", "外面", "出门"}

# 股票/指数别名 → 腾讯行情代码
STOCK_ALIAS = {
    "上证指数": "sh000001", "上证": "sh000001", "大盘": "sh000001",
    "深证成指": "sz399001", "深成指": "sz399001",
    "创业板指": "sz399006", "创业板": "sz399006",
    "沪深300": "sh000300", "科创50": "sh000688",
    "贵州茅台": "sh600519", "茅台": "sh600519",
    "宁德时代": "sz300750", "比亚迪": "sz002594", "五粮液": "sz000858",
    "招商银行": "sh600036", "工商银行": "sh601398", "中国平安": "sh601318",
    "隆基绿能": "sh601012", "东方财富": "sz300059", "京东方": "sz000725",
    "中芯国际": "sh688981", "紫金矿业": "sh601899", "美的集团": "sz000333",
    "腾讯控股": "hk00700", "腾讯": "hk00700", "阿里巴巴": "hk09988",
    "小米集团": "hk01810", "美团": "hk03690", "苹果": "usAAPL", "特斯拉": "usTSLA",
    "英伟达": "usNVDA", "微软": "usMSFT",
}

FX_PAIRS = {
    "美元": "fx_susdcny", "美金": "fx_susdcny", "USD": "fx_susdcny",
    "欧元": "fx_seurcny", "EUR": "fx_seurcny",
    "日元": "fx_sjpycny", "日币": "fx_sjpycny", "JPY": "fx_sjpycny",
    "港币": "fx_shkdcny", "港元": "fx_shkdcny", "HKD": "fx_shkdcny",
    "英镑": "fx_sgbpcny", "GBP": "fx_sgbpcny",
}

LOTTERY_NAMES = {"双色球": "ssq", "大乐透": "dlt", "福彩3d": "3d", "3d": "3d",
                 "七乐彩": "qlc", "快乐8": "kl8"}

WEEK_CN = ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"]

_CACHE: dict[str, tuple[float, dict]] = {}
_TTL = 600.0
_SEARCH_TTL = 300.0


# ---------------------------------------------------------------- 网络

def _get_bytes(url: str, timeout: float = 8.0, headers: dict | None = None) -> bytes:
    h = dict(UA)
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def _get(url: str, timeout: float = 8.0, headers: dict | None = None) -> str:
    raw = _get_bytes(url, timeout, headers)
    for enc in ("utf-8", "gbk", "gb18030"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", "ignore")


def _strip_html(s: str) -> str:
    import html as _html
    s = re.sub(r"<script.*?</script>", " ", s, flags=re.S)
    s = re.sub(r"<style.*?</style>", " ", s, flags=re.S)
    s = re.sub(r"<[^>]+>", "", s)
    s = re.sub(r'[\w:-]+="[^"]*"', "", s)   # 截断残留的属性片段
    s = _html.unescape(s).replace("\u200b", "").replace("\xa0", " ")
    return re.sub(r"\s+", " ", s).strip()


# ---------------------------------------------------------------- 通用搜索

def _search_360(q: str, timeout: float) -> list[dict]:
    text = _get("https://www.so.com/s?q=" + urllib.parse.quote(q), timeout)
    chunks = text.split('<li class="res-list')[1:5]
    out = []
    for chunk in chunks:
        chunk = chunk.split("</li>")[0]
        chunk = chunk.split(">", 1)[-1]          # 去掉被截断的起始标签
        m = re.search(r"<h3[^>]*>(.*?)</h3>", chunk, re.S)
        if not m:
            continue
        title = _strip_html(m.group(1))
        body = _strip_html(chunk)
        if title and body.startswith(title):
            body = body[len(title):]
        body = body.strip(" -|·")
        if not title:
            continue
        out.append({"title": title[:60], "snippet": body[:180]})
        if len(out) >= 4:
            break
    return out


def _search_bing(q: str, timeout: float) -> list[dict]:
    text = _get("https://cn.bing.com/search?q=" + urllib.parse.quote(q) + "&mkt=zh-CN", timeout)
    items = re.findall(r'<li class="b_algo".*?</li>', text, re.S)[:4]
    out = []
    for it in items:
        ti = re.search(r"<h2>.*?<a[^>]*>(.*?)</a>", it, re.S)
        sn = re.search(r"<p[^>]*>(.*?)</p>", it, re.S)
        if not ti:
            continue
        out.append({"title": _strip_html(ti.group(1))[:60],
                    "snippet": _strip_html(sn.group(1))[:180] if sn else ""})
    return out


def search(q: str, cfg: dict | None = None) -> dict:
    cfg = cfg or {}
    timeout = float(cfg.get("timeout", 8))
    q = (q or "").strip()[:80]
    if not q:
        return {"ok": False, "text": "没听清要查什么", "speak": ""}
    key = f"search:{q}"
    now = time.time()
    hit = _CACHE.get(key)
    if hit and now - hit[0] < _SEARCH_TTL:
        return hit[1]

    items: list[dict] = []
    err = ""
    for engine in (_search_360, _search_bing):
        try:
            items = engine(q, timeout)
        except Exception as exc:
            err = type(exc).__name__
            items = []
        if items:
            break
    if not items:
        result = {"ok": False, "text": f"没搜到「{q}」的结果{('（' + err + '）') if err else ''}",
                  "speak": "", "items": []}
        _CACHE[key] = (now, result)
        return result

    lines = [f"{i + 1}. {it['title']}：{it['snippet']}" for i, it in enumerate(items)]
    text = "；".join(it["title"] for it in items[:3])
    speak = "网页搜索摘要（供你概括，不要念网址）：\n" + "\n".join(lines)
    result = {"ok": True, "text": f"搜到 {len(items)} 条：{text}", "speak": speak,
              "items": items, "query": q}
    _CACHE[key] = (now, result)
    return result


# ---------------------------------------------------------------- 天气

def city_code(name: str, timeout: float = 8.0) -> str:
    name = (name or "").strip()
    if not name:
        return ""
    if name in CITY_CODES:
        return CITY_CODES[name]
    try:
        text = _get("http://toy1.weather.com.cn/search?cityname=" + urllib.parse.quote(name),
                    timeout, {"Referer": "http://www.weather.com.cn/"})
        m = re.search(r'"ref"\s*:\s*"(\d{9})~([^~]*)~([^~]*)', text)
        if m:
            return m.group(1)
    except Exception:
        pass
    for key, code in CITY_CODES.items():
        if name in key or key in name:
            return code
    return ""


def _parse_sk(text: str) -> dict:
    m = re.search(r"=\s*(\{.*\})", text, re.S)
    if not m:
        return {}
    try:
        return json.loads(m.group(1))
    except json.JSONDecodeError:
        return {}


def weather(city: str, cfg: dict | None = None) -> dict:
    cfg = cfg or {}
    timeout = float(cfg.get("timeout", 8))
    cache_key = f"wx:{city}"
    now = time.time()
    hit = _CACHE.get(cache_key)
    if hit and now - hit[0] < _TTL:
        return hit[1]

    code = city_code(city, timeout)
    if not code:
        return {"ok": False, "city": city, "text": f"没找到「{city}」这个城市", "speak": ""}

    sk, fc = {}, {}
    try:
        sk = _parse_sk(_get(f"http://d1.weather.com.cn/sk_2d/{code}.html", timeout,
                            {"Referer": "http://www.weather.com.cn/"}))
    except Exception:
        sk = {}
    try:
        payload = json.loads(_get(f"http://t.weather.itboy.net/api/weather/city/{code}", timeout))
        fc = payload.get("data") or {}
    except Exception:
        fc = {}

    if not sk and not fc:
        return {"ok": False, "city": city, "text": f"天气服务暂时没响应（{city}）", "speak": ""}

    name = sk.get("cityname") or fc.get("city") or city
    temp = sk.get("temp") or fc.get("wendu") or ""
    weather_txt = sk.get("weather") or ""
    humidity = sk.get("SD") or fc.get("shidu") or ""
    wind = (sk.get("WD", "") + sk.get("WS", "")).strip()
    today = (fc.get("forecast") or [{}])[0] if fc.get("forecast") else {}
    high = (today.get("high") or "").replace("高温", "").strip()
    low = (today.get("low") or "").replace("低温", "").strip()
    kind = today.get("type") or weather_txt
    tip = today.get("notice") or ""
    quality = fc.get("quality") or ""

    bits = []
    if kind:
        bits.append(kind)
    if temp:
        bits.append(f"{temp}℃")
    if high and low:
        bits.append(f"今天 {low}~{high}")
    if humidity:
        bits.append(f"湿度{humidity}")
    if wind:
        bits.append(wind)
    if quality:
        bits.append(f"空气{quality}")
    text = f"{name} " + " · ".join(bits) if bits else f"{name} 暂无数据"

    speak_bits = [f"{name}现在{kind or '天气未知'}{('，' + temp + '℃') if temp else ''}"]
    if high and low:
        speak_bits.append(f"今天{low}到{high}")
    if humidity:
        speak_bits.append(f"湿度{humidity}")
    if wind:
        speak_bits.append(wind)
    if quality:
        speak_bits.append(f"空气质量{quality}")
    if tip:
        speak_bits.append(tip)
    speak = "，".join(speak_bits)

    result = {"ok": True, "city": name, "text": text, "speak": speak,
              "data": {"temp": temp, "kind": kind, "high": high, "low": low,
                       "humidity": humidity, "wind": wind, "quality": quality, "tip": tip}}
    _CACHE[cache_key] = (now, result)
    return result


# ---------------------------------------------------------------- 股票 / 汇率

def _stock_code(query: str) -> str:
    q = (query or "").strip()
    if q in STOCK_ALIAS:
        return STOCK_ALIAS[q]
    for name, code in STOCK_ALIAS.items():
        if name in q or q in name:
            return code
    m = re.search(r"(?<!\d)(\d{6})(?!\d)", q)
    if m:
        code = m.group(1)
        if code.startswith(("6", "9", "5")):
            return "sh" + code
        if code.startswith(("0", "3", "1")):
            return "sz" + code
        if code.startswith(("4", "8")):
            return "bj" + code
    m = re.search(r"(us|hk)\s*([A-Za-z0-9.]{1,8})", q, re.I)
    if m:
        return m.group(1).lower() + m.group(2).upper()
    return ""


def stock(query: str, cfg: dict | None = None) -> dict:
    cfg = cfg or {}
    timeout = float(cfg.get("timeout", 8))
    code = _stock_code(query)
    if not code:
        return {"ok": False, "text": f"没找到「{query}」对应的股票代码", "speak": ""}
    key = f"stock:{code}"
    now = time.time()
    hit = _CACHE.get(key)
    if hit and now - hit[0] < 120:
        return hit[1]
    try:
        raw = _get(f"https://qt.gtimg.cn/q={code}", timeout).split("=", 1)[-1].strip(' ;"')
        f = raw.split("~")
        if len(f) < 35:
            raise ValueError("bad payload")
        name, price, prev = f[1], float(f[3]), float(f[4])
        change, pct = float(f[31]), float(f[32])
        high, low = f[33], f[34]
    except Exception as exc:
        return {"ok": False, "text": f"行情没取到（{type(exc).__name__}）", "speak": ""}

    arrow = "涨" if change > 0 else ("跌" if change < 0 else "平")
    text = f"{name} {price:.2f}（{arrow} {abs(change):.2f}，{pct:+.2f}%）今高 {high} 今低 {low}"
    speak = (f"{name}现在{price:.2f}，{'涨' if change >= 0 else '跌'}了{abs(change):.2f}，"
             f"幅度{abs(pct):.2f}%，今天最高{high}，最低{low}，昨收{prev:.2f}")
    result = {"ok": True, "text": text, "speak": speak,
              "data": {"name": name, "price": price, "change": change, "pct": pct}}
    _CACHE[key] = (now, result)
    return result


def fx(query: str, cfg: dict | None = None) -> dict:
    cfg = cfg or {}
    timeout = float(cfg.get("timeout", 8))
    q = query or ""
    pair, label = "", ""
    for name, code in FX_PAIRS.items():
        if name in q or name.upper() in q.upper():
            pair, label = code, name
            break
    if not pair:
        pair, label = "fx_susdcny", "美元"
    key = f"fx:{pair}"
    now = time.time()
    hit = _CACHE.get(key)
    if hit and now - hit[0] < 120:
        return hit[1]
    try:
        text = _get(f"https://hq.sinajs.cn/list={pair}", timeout,
                    {"Referer": "https://finance.sina.com.cn"})
        body = text.split('"')[1]
        price = float(body.split(",")[1])
    except Exception as exc:
        return {"ok": False, "text": f"汇率没取到（{type(exc).__name__}）", "speak": ""}
    unit = "100" if label in ("日元", "日币") else "1"
    shown = price * 100 if unit == "100" else price
    text = f"{unit}{label} ≈ {shown:.4f} 人民币"
    speak = f"现在{unit}{label}大约能换{shown:.4f}块人民币"
    result = {"ok": True, "text": text, "speak": speak,
              "data": {"pair": pair, "rate": price, "unit": unit}}
    _CACHE[key] = (now, result)
    return result


# ---------------------------------------------------------------- 彩票 / IP / 计算

def lottery(query: str, cfg: dict | None = None) -> dict:
    cfg = cfg or {}
    timeout = float(cfg.get("timeout", 8))
    q = (query or "").lower()
    game, name = "ssq", "双色球"
    for k, v in LOTTERY_NAMES.items():
        if k in q:
            game, name = v, k
            break
    key = f"lot:{game}"
    now = time.time()
    hit = _CACHE.get(key)
    if hit and now - hit[0] < _TTL:
        return hit[1]
    try:
        text = _get("https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice"
                    f"?name={game}&issueCount=1", timeout,
                    {"Referer": "https://www.cwl.gov.cn/"})
        data = json.loads(text)
        rec = (data.get("result") or [{}])[0]
        if not rec:
            raise ValueError("empty")
    except Exception as exc:
        return {"ok": False, "text": f"开奖数据没取到（{type(exc).__name__}）", "speak": ""}

    red = rec.get("red") or rec.get("frontWinningNum") or ""
    blue = rec.get("blue") or rec.get("backWinningNum") or ""
    code, date = rec.get("code", ""), (rec.get("date") or "")[:10]
    text = f"{name} 第{code}期（{date}）：红 {red} 蓝 {blue}".strip()
    speak = f"{name}第{code}期，{date}开奖，红球{red}，蓝球{blue}"
    result = {"ok": True, "text": text, "speak": speak,
              "data": {"code": code, "date": date, "red": red, "blue": blue}}
    _CACHE[key] = (now, result)
    return result


def ip_lookup(query: str, cfg: dict | None = None) -> dict:
    cfg = cfg or {}
    timeout = float(cfg.get("timeout", 8))
    m = re.search(r"(\d{1,3}(?:\.\d{1,3}){3})", query or "")
    if not m:
        return {"ok": False, "text": "没看到 IP 地址", "speak": ""}
    ip = m.group(1)
    key = f"ip:{ip}"
    now = time.time()
    hit = _CACHE.get(key)
    if hit and now - hit[0] < _TTL:
        return hit[1]
    try:
        data = json.loads(_get(f"http://ip-api.com/json/{ip}?lang=zh-CN", timeout))
        if data.get("status") != "success":
            raise ValueError(data.get("message", "fail"))
    except Exception as exc:
        return {"ok": False, "text": f"IP 查询失败（{type(exc).__name__}）", "speak": ""}
    where = "".join(x for x in (data.get("country"), data.get("regionName"), data.get("city")) if x)
    text = f"{ip} → {where} · {data.get('isp', '')}"
    speak = f"{ip}这个地址在{where}，运营商是{data.get('isp', '未知')}"
    result = {"ok": True, "text": text, "speak": speak, "data": data}
    _CACHE[key] = (now, result)
    return result


CALC_MULTI = [("除以", "/"), ("等于几", ""), ("等于多少", ""), ("算一下", ""),
              ("帮我算", ""), ("帮我", ""), ("一下", ""), ("多少", ""),
              ("等于", ""), ("算", ""), ("的", "")]
CALC_SINGLE = str.maketrans({"×": "*", "÷": "/", "（": "(", "）": ")",
                             "＋": "+", "－": "-", "加": "+", "减": "-",
                             "乘": "*", "除": "/"})


def calc(query: str, cfg: dict | None = None) -> dict:
    expr = query or ""
    for a, b in CALC_MULTI:
        expr = expr.replace(a, b)
    expr = expr.translate(CALC_SINGLE)
    expr = re.sub(r"[^0-9+\-*/().%\s]", "", expr).strip().replace(" ", "")
    if not expr or not re.search(r"\d", expr):
        return {"ok": False, "text": "没认出算式", "speak": ""}
    if re.search(r"\*\*|//|__", expr):
        return {"ok": False, "text": "算式太复杂了", "speak": ""}
    try:
        value = eval(expr, {"__builtins__": {}}, {})  # 只含数字与四则运算
    except Exception:
        return {"ok": False, "text": f"算不出来：{expr}", "speak": ""}
    if isinstance(value, float):
        value = round(value, 6)
        if value == int(value):
            value = int(value)
    text = f"{expr} = {value}"
    speak = f"{expr}等于{value}"
    return {"ok": True, "text": text, "speak": speak, "data": {"expr": expr, "value": value}}


# ---------------------------------------------------------------- 时间 / 日期

def now_time() -> dict:
    dt = datetime.now()
    text = dt.strftime("%H:%M")
    speak = f"现在是{dt.hour}点{dt.minute:02d}分"
    return {"ok": True, "text": text, "speak": speak, "data": {"hour": dt.hour, "minute": dt.minute}}


def today_date() -> dict:
    dt = datetime.now()
    week = WEEK_CN[dt.weekday()]
    text = dt.strftime("%Y年%m月%d日 ") + week
    speak = f"今天是{dt.month}月{dt.day}日，{week}"
    return {"ok": True, "text": text, "speak": speak, "data": {"date": dt.strftime("%Y-%m-%d"), "week": week}}


# ---------------------------------------------------------------- 意图识别

WEATHER_RE = re.compile(r"天气|气温|多少度|几度|冷不冷|热不热|下雨|带伞|穿什么|降温|升温")
TIME_RE = re.compile(r"几点|什么时间|现在时间|几时")
DATE_RE = re.compile(r"几号|星期几|礼拜几|什么日子|今天是什么")
STOCK_RE = re.compile(r"股价|股票|大盘|指数|行情|涨了|跌了|一股|收盘|开盘|市值|涨停|跌停")
FX_RE = re.compile(r"汇率|兑人民币|换人民币|美元|欧元|日元|港币|英镑|美金")
LOTTERY_RE = re.compile(r"彩票|双色球|大乐透|开奖|中奖号码|福彩|七乐彩|快乐8")
IP_RE = re.compile(r"ip地址|ip归属|归属地|这个ip|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}", re.I)
CALC_RE = re.compile(r"[\d.]+\s*[+\-*/×÷]\s*[\d.]|等于多少|算一下|帮我算|等于几")

QUESTION_RE = re.compile(r"[?？]|什么|啥|谁|哪|怎么|为什么|为啥|多少|多少钱|吗|是不是|"
                         r"能不能|有没有|怎么样|如何|介绍|是什么|是谁|在哪")
# 只有观众明确「让你去查」才联网搜索；平常聊天不调工具，靠模型自己的知识回答
SEARCH_ASK_RE = re.compile(
    r"(帮我查一下|帮我查查|帮我查下|帮我查|给我查一下|给我查下|给我查|替我查一下|替我查|"
    r"帮忙查一下|帮忙查下|帮忙查|查一下|查一查|查查|查下|查个|"
    r"搜索一下|搜索|搜一下|搜一搜|搜搜|搜下|"
    r"百度一下|百度|谷歌一下|谷歌|"
    r"上网查|网上查|联网查|查资料|查一下资料|查证|核实一下|核实)"
)
# 这些「查」是玩笑话，不算查询
SEARCH_NOISE_RE = re.compile(r"查岗|查户口|查水表|查寝|查无此人|检查|查房")

CASUAL_RE = re.compile(r"你在干|干嘛呢|在做什么|吃了吗|你是谁|你叫什么|你好|在吗|晚安|早安|"
                       r"哈哈|笑死|好听|加油|谢谢|再见|拜拜|想你了")

_CITY_TAIL = re.compile(r"([\u4e00-\u9fa5]{2,6}?)(?:今天|明天|后天|现在|的)*的?(?:天气|气温)")
_CITY_RAIN = re.compile(r"([\u4e00-\u9fa5]{2,6}?)(?:今天|明天|后天|现在)?(?:会|要|会不会|下)?(?:下雨|下雪|降温|升温)")
_CITY_HEAD = re.compile(r"(?:天气|气温)(?:怎么样|如何|咋样)?[，,、\s]*(?:在|是)?([\u4e00-\u9fa5]{2,6})")


def _clean_city(name: str) -> str:
    name = (name or "").strip(" 的了呢啊呀吧，,。.？?！!")
    for word in ("帮我查一下", "帮我查下", "帮我查", "帮我看看", "帮我", "查一下", "查下", "查查",
                 "看一下", "看看", "请问", "我想知道", "我想", "知道", "一下", "那边", "这里",
                 "今天", "明天", "后天", "现在", "的", "天气", "气温",
                 "怎么样", "怎样", "咋样", "如何", "好吗", "好不"):
        name = name.replace(word, "")
    return name.strip()


def _city_in(text: str) -> str:
    city = ""
    m = _CITY_TAIL.search(text)
    if m:
        city = _clean_city(m.group(1))
    if not city:
        m = _CITY_RAIN.search(text)
        if m:
            city = _clean_city(m.group(1))
    if not city:
        m = _CITY_HEAD.search(text)
        if m:
            city = _clean_city(m.group(1))
    if not city:
        for known in sorted(CITY_CODES, key=len, reverse=True):
            if known in text:
                city = known
                break
    if city in STOP_CITY or len(city) < 2 or len(city) > 8:
        city = ""
    if any(w in city for w in ("怎么", "什么", "多少", "如何", "咋")):
        city = ""
    return city


_QUERY_PREFIX = (
    "帮我查一下", "帮我查查", "帮我查下", "帮我查", "给我查一下", "给我查下", "给我查",
    "替我查一下", "替我查", "帮忙查一下", "帮忙查下", "帮忙查",
    "帮我搜索一下", "帮我搜一下", "帮我搜", "搜索一下", "搜一下", "搜一搜", "搜下", "搜搜",
    "查一下资料", "查一下", "查一查", "查查", "查下", "查个", "查",
    "百度一下", "百度", "谷歌一下", "谷歌", "上网查", "网上查", "联网查", "查证", "核实一下", "核实",
    "帮我", "请问", "麻烦", "你能不能", "你能", "可以", "给我",
)


def _clean_query(text: str) -> str:
    """把「帮我查一下」这类客套前缀剥掉，留下真正要搜的关键词。"""
    q = text or ""
    for word in _QUERY_PREFIX:
        q = q.replace(word, "")
    q = q.strip(" 的了呢啊呀吧嘛，,。.？?！!：:、　")
    return q or (text or "").strip()


# ---------------------------------------------------------------- 本场数据（直播战报）

_STATS_PROVIDER = None


def set_stats_provider(fn) -> None:
    """app 启动时把「本场数据」的取数函数注册进来（避免 tools 反向依赖 app）。"""
    global _STATS_PROVIDER
    _STATS_PROVIDER = fn


STATS_RE = re.compile(
    r"多少\s*token|token.{0,4}(?:消耗|成本|花|烧|账单)|烧了多少|花了多少|成本多少|电费|"
    r"多少.{0,3}(?:礼物|打赏|收入|流水)|(?:礼物|打赏).{0,4}(?:多少|几个|几次|收入|流水)|"
    r"赚了多少|赚多少|收入(?:多少|怎么样|如何)|"
    r"战报|kpi|播了多久|播多久|本场数据|今天赚",
    re.I,
)


def live_stats() -> dict:
    d = _STATS_PROVIDER() if _STATS_PROVIDER else None
    if not d:
        return {"ok": False, "name": "stats", "text": "直播数据还没接上（服务刚启动？）", "speak": ""}
    tokens = int(d.get("tokens") or 0)
    tin = int(d.get("input_tokens") or 0)
    tout = int(d.get("output_tokens") or 0)
    gifts = int(d.get("gifts") or 0)
    money = float(d.get("gift_value") or 0)
    req = int(d.get("requests") or 0)
    up = int(d.get("uptime") or 0)
    cost = tokens / 1_000_000 * float(d.get("price_per_million") or 2.0)
    hours, mins = up // 3600, (up % 3600) // 60
    span = (f"{hours} 小时 {mins} 分钟" if hours else f"{mins} 分钟")
    text = (f"本场烧了 {tokens:,} token（输入 {tin:,} / 输出 {tout:,}，约 ¥{cost:.2f}），"
            f"收到 {gifts} 次礼物共 ¥{money:.1f}，回了 {req} 条，已播 {span}。")
    speak = text
    return {"ok": True, "name": "stats", "text": text, "speak": speak,
            "args": {}, "data": {**d, "cost_estimate": round(cost, 3)}}


def detect(text: str) -> tuple[str, dict] | None:
    """判断这句话要不要调工具，返回 (工具名, 参数)。结构化工具优先，其次通用搜索。"""
    text = (text or "").strip()
    if not text:
        return None

    if STATS_RE.search(text):
        return ("stats", {})
    if CALC_RE.search(text) and re.search(r"\d", text):
        return ("calc", {"query": text})
    if IP_RE.search(text):
        return ("ip", {"query": text})
    if LOTTERY_RE.search(text):
        return ("lottery", {"query": text})
    if FX_RE.search(text):
        return ("fx", {"query": text})
    if STOCK_RE.search(text):
        return ("stock", {"query": text})
    if WEATHER_RE.search(text):
        return ("weather", {"city": _city_in(text)})
    if TIME_RE.search(text):
        return ("time", {})
    if DATE_RE.search(text):
        return ("date", {})

    # 兜底搜索：只有观众明确说「帮我查/搜一下」才联网，
    # 平常的知识性问题交给模型自己回答，不打扰网络、也不拖慢回复
    if SEARCH_ASK_RE.search(text) and not SEARCH_NOISE_RE.search(text):
        query = _clean_query(text)
        if 2 <= len(query) <= 60:
            return ("search", {"query": query})
    return None


def run(name: str, args: dict | None = None, cfg: dict | None = None) -> dict:
    args = args or {}
    cfg = cfg or {}
    if name == "weather":
        city = args.get("city") or cfg.get("default_city") or "北京"
        out = weather(city, cfg)
        out["args"] = {"city": city}
    elif name == "time":
        out = now_time()
        out["args"] = {}
    elif name == "date":
        out = today_date()
        out["args"] = {}
    elif name == "search":
        out = search(str(args.get("query", "")), cfg)
        out["args"] = args
    elif name == "stock":
        out = stock(str(args.get("query", "")), cfg)
        out["args"] = args
    elif name == "fx":
        out = fx(str(args.get("query", "")), cfg)
        out["args"] = args
    elif name == "lottery":
        out = lottery(str(args.get("query", "")), cfg)
        out["args"] = args
    elif name == "ip":
        out = ip_lookup(str(args.get("query", "")), cfg)
        out["args"] = args
    elif name == "calc":
        out = calc(str(args.get("query", "")), cfg)
        out["args"] = args
    elif name == "stats":
        out = live_stats()
        out["args"] = {}
    else:
        return {"ok": False, "name": name, "text": f"没有这个工具：{name}", "speak": ""}
    out["name"] = name
    return out


def maybe_run(text: str, cfg: dict | None = None) -> dict | None:
    cfg = cfg or {}
    if not cfg.get("enable", True):
        return None
    hit = detect(text)
    if not hit:
        return None
    name, args = hit
    try:
        return run(name, args, cfg)
    except Exception as exc:  # 工具失败不能影响回复
        return {"ok": False, "name": name, "text": f"工具出错：{type(exc).__name__}", "speak": ""}


CATALOG = [
    {"name": "stats", "desc": "本场战报：烧了多少 token、收了多少钱礼物、回了多少条、播了多久", "example": "今天烧了多少 token"},
    {"name": "search", "desc": "通用网页搜索：要你明确说「帮我查/搜一下」才联网，平常聊天不搜", "example": "帮我查一下大熊猫吃什么"},
    {"name": "weather", "desc": "天气：实况 + 今日高低温 + 湿度风力 + 空气质量", "example": "杭州天气怎么样"},
    {"name": "stock", "desc": "股票/指数行情：茅台、比亚迪、上证指数、600519", "example": "茅台股价多少"},
    {"name": "fx", "desc": "人民币汇率：美元/欧元/日元/港币/英镑", "example": "美元汇率多少"},
    {"name": "lottery", "desc": "彩票开奖：双色球 / 大乐透 / 3D", "example": "双色球开奖号码"},
    {"name": "ip", "desc": "IP 归属地查询", "example": "8.8.8.8 归属地"},
    {"name": "calc", "desc": "算式计算", "example": "算一下 128*7"},
    {"name": "time", "desc": "现在几点", "example": "现在几点了"},
    {"name": "date", "desc": "今天几号、星期几", "example": "今天星期几"},
]
