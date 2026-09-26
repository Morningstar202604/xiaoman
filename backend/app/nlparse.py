"""自然语言记账解析：规则引擎优先（本地秒回），AI 兜底（歧义/未知分类）。

入账结果约定：{date: YYYY-MM-DD, item: str, category: str, amount: 正为收入、负为支出}
规则引擎只要拿到「金额 + 收支方向」即可入账（日期默认今天、分类/名称兜底），
拿不到金额才升级给 AI 解析。
"""

from __future__ import annotations

import re
from datetime import date, datetime, timedelta

# 分类关键词（按序匹配，越靠前越具体；收入词在收入分支单独判断）
CATEGORY_KEYWORDS: list[tuple[str, list[str]]] = [
    (
        "交通",
        [
            "打车",
            "滴滴",
            "出租",
            "地铁",
            "公交",
            "高铁",
            "火车",
            "机票",
            "加油",
            "停车",
            "共享单车",
            "骑行",
        ],
    ),
    (
        "餐饮",
        [
            "早餐",
            "午餐",
            "晚餐",
            "夜宵",
            "外卖",
            "火锅",
            "烧烤",
            "咖啡",
            "奶茶",
            "吃饭",
            "早饭",
            "午饭",
            "晚饭",
            "喝",
            "下馆子",
            "零食",
            "水果",
        ],
    ),
    ("居住", ["房租", "房贷", "水电", "物业", "燃气", "宽带", "话费", "供暖"]),
    (
        "购物",
        [
            "淘宝",
            "京东",
            "拼多多",
            "衣服",
            "超市",
            "商场",
            "日用品",
            "家电",
            "买了",
            "购物",
        ],
    ),
    ("订阅", ["会员", "订阅", "视频", "音乐", "网盘", "云盘", "自动续费"]),
    ("投资", ["基金", "股票", "加仓", "买入", "定投", "黄金"]),
    ("还款", ["还款", "信用卡", "花呗", "白条", "还贷"]),
    ("收入", ["工资", "奖金", "报销", "退款", "到账", "分红", "利息", "兼职", "收入"]),
]

INCOME_KEYWORDS = [
    "工资",
    "奖金",
    "报销",
    "退款",
    "到账",
    "分红",
    "利息",
    "收入",
    "兼职",
    "赚了",
]

# 从句子中剔除的语气词 / 动词，用于提炼「名称」
NOISE_WORDS = [
    "今天",
    "昨天",
    "前天",
    "大前天",
    "花了",
    "消费",
    "支出",
    "用了",
    "用了",
    "付了",
    "扫码",
    "支付",
    "块钱",
    "块",
    "元",
    "钱",
    "大概",
    "约",
]

# 金额识别：带货币单位的优先；无单位时先剔掉易混淆的数字片段再取第一个
_AMOUNT_PREFIX = re.compile(r"(?:¥|￥)\s*(\d[\d,]*(?:\.\d+)?)\s*(万)?")
_AMOUNT_SUFFIX = re.compile(r"(\d[\d,]*(?:\.\d+)?)\s*(万)?\s*(?:元|块钱|块|人民币)")
_AMOUNT_PLAIN = re.compile(r"(\d[\d,]*(?:\.\d+)?)\s*(万)?")
# 月份、字母型号（iPhone15）、数量单位（10股）——都不是金额
_NON_AMOUNT_DIGITS = re.compile(
    r"\d{1,2}\s*月|[A-Za-z]+\d+|\d+\s*(?:股|份|手|个|件|人|天|次|张|瓶|斤|米|码|楼|号)"
)


def _to_amount(m: re.Match) -> float:
    num = float(m.group(1).replace(",", ""))
    if m.group(2) == "万":
        num *= 10000
    return round(num, 2)


def _parse_amount(text: str) -> float | None:
    """提取金额：支持千分位、小数、带「万」。返回元，None 表示没有金额。"""
    for pattern in (_AMOUNT_PREFIX, _AMOUNT_SUFFIX):
        m = pattern.search(text)
        if m:
            return _to_amount(m)
    m = _AMOUNT_PLAIN.search(_NON_AMOUNT_DIGITS.sub(" ", text))
    return _to_amount(m) if m else None


def _parse_date(text: str, today: date) -> tuple[str | None, str]:
    """返回 (YYYY-MM-DD, 去掉日期后的剩余文本)。"""
    # 相对日期（长词优先，否则「大前天」会被「前天」抢走）
    for offset, word in ((3, "大前天"), (2, "前天"), (1, "昨天"), (0, "今天")):
        if word in text:
            d = today - timedelta(days=offset)
            return d.isoformat(), text.replace(word, " ", 1)
    # 显式：YYYY-MM-DD / YYYY年M月D日
    m = re.search(r"(\d{4})[-年/](\d{1,2})[-月/](\d{1,2})日?", text)
    if m:
        try:
            d = date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            return None, text  # 日历非法（如 13月40日）：不当日期，留给金额解析
        return d.isoformat(), re.sub(
            r"\d{4}[-年/]\d{1,2}[-月/]\d{1,2}日?", " ", text, count=1
        )
    # 今年内：M月D日 / M月D号
    m = re.search(r"(\d{1,2})月(\d{1,2})[日号]", text)
    if m:
        try:
            d = date(today.year, int(m.group(1)), int(m.group(2)))
            return d.isoformat(), re.sub(r"\d{1,2}月\d{1,2}[日号]", " ", text, count=1)
        except ValueError:
            return None, text
    return None, text


def _clean_item(rest: str, category: str, hit: str | None) -> str:
    """从剩余文本提炼名称：命中关键词用关键词，否则去噪词后取主干。"""
    if hit:
        return hit
    t = rest
    for w in NOISE_WORDS:
        t = t.replace(w, " ")
    t = re.sub(r"\d[\d,.]*", " ", t)  # 去掉残留金额数字
    t = re.sub(r"\s+", " ", t).strip(" ，。！？、")
    t = re.sub(r"^[,，:：\-]+|[,，:：\-]+$", "", t).strip()
    return t[:40] or category


def parse(text: str) -> dict | None:
    """规则解析。失败（拿不到金额）返回 None。"""
    t = text.strip()
    if not t:
        return None

    today = datetime.now().astimezone().date()
    d, rest = _parse_date(t, today)
    amount = _parse_amount(rest)
    if amount is None:
        return None

    is_income = any(k in t for k in INCOME_KEYWORDS)
    category, hit = "其他", None
    for cat, words in CATEGORY_KEYWORDS:
        if cat == "收入":
            continue
        for w in words:
            if w in t:
                category, hit = cat, w
                break
        if hit:
            break
    if is_income:
        category = "收入"
        hit = next((w for w in INCOME_KEYWORDS if w in t), None)
        amount = abs(amount)
    else:
        amount = -abs(amount)

    return {
        "date": d or today.isoformat(),
        "item": _clean_item(rest, category, hit),
        "category": category,
        "amount": amount,
    }


async def parse_with_ai(text: str) -> dict | None:
    """AI 兜底：交给配置的模型解析，严格校验后返回；失败返回 None。"""
    from . import llm

    today = datetime.now().astimezone().date().isoformat()
    system = (
        "你是记账解析器。从用户的一句话里提取 JSON，字段："
        '{"type":"expense|income","category":"餐饮|居住|交通|购物|订阅|投资|还款|收入|其他",'
        '"amount":数字(元，只写数字), "date":"YYYY-MM-DD", "item":"简短名称(≤10字)"}。'
        "只输出 JSON，不要任何解释。今天日期：" + today
    )
    data = await llm.json_complete(system, text, timeout=20.0)
    if not isinstance(data, dict):
        return None
    try:
        amount = float(data.get("amount", 0))
        if amount <= 0:
            return None
        cat = str(data.get("category", "其他")).strip() or "其他"
        cat = (
            cat
            if cat
            in {"餐饮", "居住", "交通", "购物", "订阅", "投资", "还款", "收入", "其他"}
            else "其他"
        )
        item = str(data.get("item", "")).strip()[:40] or cat
        # 日期校验：允许今天/昨天/前天等相对词（AI 已给绝对日期则校验格式）
        d = str(data.get("date", "")).strip()
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", d):
            d = datetime.now().astimezone().date().isoformat()
        amount = abs(amount) if data.get("type") == "income" else -abs(amount)
        return {"date": d, "item": item, "category": cat, "amount": amount}
    except Exception:  # noqa: BLE001 — 模型输出不规整时回退规则结果
        return None
