"""Agent 工具层：把确定性分析内核暴露成 LLM 可调用的工具（function calling）。

设计原则：
- 所有工具都是确定性计算（数字来自本地数据），模型只决定"调哪个工具、以什么参数调"，
  不负责产出数字 —— 延续「确定性内核优先」。
- 工具结果返回时截断为摘要级（关键数字 + 前几条明细），控制 token 与外发体量。
- 工具失败返回明确错误串，由 agent 循环决定是否重试/降级。
"""

from __future__ import annotations

import json
from typing import Any

from . import analysis, db, nlparse
from .quotes import kline as fetch_kline

# ---------------------------------------------------------------------------
# 工具执行体（纯函数，可单测）
# ---------------------------------------------------------------------------


def _compact_market(market: dict[str, Any]) -> dict[str, Any]:
    """market_view 结果压成给模型的摘要：总额 + 前 5 持仓 + 集中度告警。"""
    return {
        "total_market_value": market["total_market_value"],
        "total_cost": market["total_cost"],
        "total_pnl": market["total_pnl"],
        "total_pnl_pct": market["total_pnl_pct"],
        "top_positions": [
            {
                "name": p["name"],
                "symbol": p["symbol"],
                "market_value": p["market_value"],
                "pnl": p["pnl"],
                "pnl_pct": p["pnl_pct"],
            }
            for p in market["positions"][:5]
        ],
        "concentration_warnings": [
            a["name"] for a in market["concentration"]["asset_breaches"]
        ],
    }


def _compact_ledger(ledger: dict[str, Any]) -> dict[str, Any]:
    return {
        "month": ledger["month"],
        "income": ledger["income"],
        "expense": ledger["expense"],
        "net": ledger["net"],
        "savings_rate": ledger["savings_rate"],
        "top_categories": ledger["by_category"][:5],
        "subscription_monthly": ledger["subscription_monthly"],
        "debt_monthly": ledger["debt_monthly"],
        "dti_pct": ledger["dti_pct"],
        "emergency": ledger["emergency"],
    }


async def tool_get_market_view(_args: dict[str, Any]) -> str:
    """查持仓与行情：总市值、盈亏、集中度。无参数。"""
    positions = await db.list_positions()
    from .quotes import live_quotes

    live = await live_quotes(positions)
    if not positions:
        return json.dumps(
            {"empty": True, "hint": "还没有持仓，提示用户去添加持仓后再问"}, ensure_ascii=False
        )
    return json.dumps(_compact_market(analysis.market_view(positions, live)), ensure_ascii=False)


async def tool_get_ledger_view(_args: dict[str, Any]) -> str:
    """查账本：本月收支、结余、储蓄率、订阅、负债、应急金。无参数。"""
    settings = await db.get_settings()
    positions = await db.list_positions()
    from .quotes import live_quotes

    live = await live_quotes(positions)
    txs = await db.list_transactions()
    if not txs:
        return json.dumps(
            {"empty": True, "hint": "还没有流水，提示用户先记账再问"}, ensure_ascii=False
        )
    led = analysis.ledger_view(
        txs,
        await db.list_subscriptions(),
        await db.list_debts(),
        settings,
        positions,
        live,
    )
    return json.dumps(_compact_ledger(led), ensure_ascii=False)


async def tool_get_risk_flags(_args: dict[str, Any]) -> str:
    """查风控规则：集中度、应急金、高息负债、负债收入比、储蓄率告警。无参数。"""
    positions = await db.list_positions()
    from .quotes import live_quotes

    live = await live_quotes(positions)
    settings = await db.get_settings()
    m = analysis.market_view(positions, live)
    led = analysis.ledger_view(
        await db.list_transactions(),
        await db.list_subscriptions(),
        await db.list_debts(),
        settings,
        positions,
        live,
    )
    flags = analysis.risk_checks(m, led)
    return json.dumps(
        {"count": len(flags), "flags": [f["text"] for f in flags]},
        ensure_ascii=False,
    )


async def tool_get_budget(args: dict[str, Any]) -> str:
    """查预算：某月预算设置与实时使用率。参数：month（YYYY-MM，可省略=本月）。"""
    from datetime import datetime

    month = str(args.get("month") or "").strip() or datetime.now().strftime("%Y-%m")
    rows = await db.list_budgets(month)
    budgets = {
        ("总预算" if r["category"] == "__total" else r["category"]): r["amount"]
        for r in rows
    }
    spent = await db.month_expense_by_category(month)
    # 与 /api/budgets 同口径：投资/还款是储蓄与转移支付，不计入预算使用
    for cat in ("投资", "还款"):
        spent.pop(cat, None)
    total_spent = round(sum(spent.values()), 2)
    total_budget = budgets.get("总预算", 0.0)
    return json.dumps(
        {
            "month": month,
            "budgets": budgets,
            "spent_by_category": spent,
            "total_spent": total_spent,
            "total_budget": total_budget,
            "over": total_budget > 0 and total_spent > total_budget,
        },
        ensure_ascii=False,
    )


async def tool_get_trend(args: dict[str, Any]) -> str:
    """查收支趋势：最近 N 个月（默认 6）收入/支出/结余。参数：months（1-24）。"""
    try:
        months = max(1, min(int(args.get("months") or 6), 24))
    except (TypeError, ValueError):
        months = 6
    return json.dumps(await db.monthly_trend(months), ensure_ascii=False)


async def tool_record_transaction(args: dict[str, Any]) -> str:
    """一句话记账：把用户说的话解析为流水并入账。参数：text（一句话，含金额）。"""
    text = str(args.get("text") or "").strip()
    if not text:
        return "缺少 text 参数"
    parsed = nlparse.parse(text)
    if parsed is None:
        parsed = await nlparse.parse_with_ai(text)
    if parsed is None:
        return "无法从这句话里解析出金额，请让用户改说「昨天打车 32 元」这类格式"
    await db.add_transaction(
        parsed["date"], parsed["item"], parsed["category"], parsed["amount"]
    )
    return json.dumps(
        {
            "ok": True,
            "date": parsed["date"],
            "item": parsed["item"],
            "category": parsed["category"],
            "amount": parsed["amount"],
        },
        ensure_ascii=False,
    )


async def tool_get_kline(args: dict[str, Any]) -> str:
    """查某标的的 K 线走势。参数：symbol（6 位代码），period（daily/weekly/monthly，默认 daily），limit（默认 60）。"""
    symbol = str(args.get("symbol") or "").strip()
    if not symbol:
        return "缺少 symbol 参数"
    period = str(args.get("period") or "daily").strip()
    try:
        limit = max(10, min(int(args.get("limit") or 60), 500))
    except (TypeError, ValueError):
        limit = 60
    data = await fetch_kline(symbol, period, limit)
    if not data:
        return f"无法获取 {symbol} 的行情（可能不是 A 股/ETF 代码，或行情源不可用）"
    # 只回传近 N 个收盘价点，控制 token
    points = [
        {"date": p["date"], "close": p["close"], "pct_change": p.get("pct_change")}
        for p in data["points"][-30:]
    ]
    return json.dumps(
        {"symbol": symbol, "period": period, "source": data["source"], "points": points},
        ensure_ascii=False,
    )


async def tool_get_goals(_args: dict[str, Any]) -> str:
    """查财务目标：目标金额、已存金额、进度、距截止月、建议月存。无参数。"""
    goals = await db.list_goals()
    if not goals:
        return json.dumps(
            {"empty": True, "hint": "用户还没有设置财务目标，可提示用户到「记账 → 目标」添加"}, ensure_ascii=False
        )
    return json.dumps(analysis.goal_progress(goals), ensure_ascii=False)


async def tool_get_user_memory(_args: dict[str, Any]) -> str:
    """查用户长期记忆：用户主动告知的长期信息（偏好、家庭、计划等）。无参数。"""
    rows = await db.list_memory()
    if not rows:
        return json.dumps({"empty": True, "hint": "暂无长期记忆"}, ensure_ascii=False)
    return json.dumps(
        [{"content": r["content"], "kind": r["kind"]} for r in rows],
        ensure_ascii=False,
    )


async def tool_save_user_memory(args: dict[str, Any]) -> str:
    """记住一条用户长期信息（如「明年计划买房」「每月收入 2 万」）。参数：content（要记住的内容）。"""
    content = str(args.get("content") or "").strip()
    if not content:
        return "缺少 content 参数"
    out = await db.add_memory(content)
    return json.dumps({"ok": True, "deduped": out.get("deduped", False)}, ensure_ascii=False)


async def tool_get_health_check(_args: dict[str, Any]) -> str:
    """跑一次结构化财务体检：资产配置 / 现金流 / 负债 / 应急金 / 目标进度 五维评分与建议。无参数。"""
    positions = await db.list_positions()
    from .quotes import live_quotes

    live = await live_quotes(positions)
    settings = await db.get_settings()
    m = analysis.market_view(positions, live)
    led = analysis.ledger_view(
        await db.list_transactions(),
        await db.list_subscriptions(),
        await db.list_debts(),
        settings,
        positions,
        live,
    )
    flags = analysis.risk_checks(m, led)
    report = analysis.health_check(m, led, flags, await db.list_goals())
    return json.dumps(report, ensure_ascii=False)


# ---------------------------------------------------------------------------
# 工具注册表：OpenAI function calling 的 JSON Schema + 执行体
# ---------------------------------------------------------------------------

TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "get_market_view",
            "description": "查询用户持仓组合：总市值、累计盈亏、前几大持仓、集中度告警。适合回答关于持仓、盈亏、资产、集中度的问题。",
            "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_ledger_view",
            "description": "查询用户账本：本月收入、支出、结余、储蓄率、支出分类、订阅、负债、应急金。适合回答关于钱花到哪、结余、负债、应急金的问题。",
            "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_risk_flags",
            "description": "运行风控规则：集中度超限、应急金不足、高息负债、负债收入比偏高、储蓄率偏低等告警。适合回答「我有什么风险」「哪里需要关注」。",
            "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_budget",
            "description": "查询预算设置与实时使用情况。适合回答关于预算、超支、还剩多少钱能花的问题。",
            "parameters": {
                "type": "object",
                "properties": {
                    "month": {
                        "type": "string",
                        "description": "月份 YYYY-MM，可省略（默认本月）",
                    }
                },
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_trend",
            "description": "查询近几个月收支趋势（收入/支出/结余）。适合回答「钱花得越来越多吗」「这个月和上个月比」等问题。",
            "parameters": {
                "type": "object",
                "properties": {"months": {"type": "integer", "description": "月份数 1-24，默认 6"}},
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "record_transaction",
            "description": "一句话记账：把用户的记账指令（如「昨天打车 32 元」「工资 8000 已到账」）解析并写入账本。仅当用户明确表达记账意图时调用。",
            "parameters": {
                "type": "object",
                "properties": {"text": {"type": "string", "description": "用户原话"}},
                "required": ["text"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_kline",
            "description": "查询某标的的K线走势（A股/ETF）。适合回答「某只股票最近走势如何」。",
            "parameters": {
                "type": "object",
                "properties": {
                    "symbol": {"type": "string", "description": "6位证券代码，如 600519"},
                    "period": {"type": "string", "enum": ["daily", "weekly", "monthly"]},
                    "limit": {"type": "integer", "description": "返回点数，默认 60"},
                },
                "required": ["symbol"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_goals",
            "description": "查询用户的财务目标：目标金额、已存金额、进度百分比、距截止月、建议月存。适合回答「我存够了吗」「目标进展如何」「还差多少」。",
            "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_user_memory",
            "description": "查询用户的长期记忆：用户主动告知的长期信息（家庭、职业、偏好、未来计划等）。回答涉及用户背景或长期规划时先查记忆。",
            "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "save_user_memory",
            "description": "记住一条用户的长期信息（如「明年计划买房」「每月收入 2 万」「有一个孩子」）。当用户在对话中主动透露可用于未来的背景信息时调用；临时性、一次性信息不要记。",
            "parameters": {
                "type": "object",
                "properties": {"content": {"type": "string", "description": "要记住的内容（一句话，含具体事实）"}},
                "required": ["content"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_health_check",
            "description": "跑一次结构化财务体检：资产配置 / 现金流 / 负债 / 应急金 / 目标进度 五个维度的评分与建议。适合回答「帮我体检一下」「我的财务状况怎么样」「哪里需要改进」。",
            "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
        },
    },
]

TOOL_IMPL: dict[str, Any] = {
    "get_market_view": tool_get_market_view,
    "get_ledger_view": tool_get_ledger_view,
    "get_risk_flags": tool_get_risk_flags,
    "get_budget": tool_get_budget,
    "get_trend": tool_get_trend,
    "record_transaction": tool_record_transaction,
    "get_kline": tool_get_kline,
    "get_goals": tool_get_goals,
    "get_user_memory": tool_get_user_memory,
    "save_user_memory": tool_save_user_memory,
    "get_health_check": tool_get_health_check,
}

# 工具返回体量上限：超过即截断（防止把整库明细喂给模型）
TOOL_RESULT_MAX_CHARS = 2500


def truncate_tool_result(text: str) -> str:
    if len(text) <= TOOL_RESULT_MAX_CHARS:
        return text
    return text[:TOOL_RESULT_MAX_CHARS] + "…（已截断，只保留关键数字）"
