"""Agent 工具层：把确定性分析内核暴露成 LLM 可调用的工具（function calling）。

设计原则：
- 所有工具都是确定性计算（数字来自本地数据），模型只决定"调哪个工具、以什么参数调"，
  不负责产出数字 —— 延续「确定性内核优先」。
- 工具结果返回时截断为摘要级（关键数字 + 前几条明细），控制 token 与外发体量。
- 工具失败返回明确错误串，由 agent 循环决定是否重试/降级。
"""

from __future__ import annotations

import json
import secrets
from pathlib import Path
from typing import Any

import httpx

from . import analysis, backup, db, nlparse, scheduler
from .quotes import kline as fetch_kline
from .quotes import invalidate_quotes_cache, quote_now

BACKUP_DIR = Path(__file__).resolve().parent.parent / "backups"

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
# 行情 / 自选 / 持仓工具：让「一句话工作流」成立——
# 搜标的 → 看行情 → 加入自选 → 看 K 线/风险 → 记录买入，全程由模型编排。
# ---------------------------------------------------------------------------

_SEARCH_URL = "https://searchapi.eastmoney.com/api/suggest/get"
_SEARCH_HEADERS = {"User-Agent": "Mozilla/5.0 (xiaoman)", "Referer": "https://quote.eastmoney.com/"}


async def tool_search_symbol(args: dict[str, Any]) -> str:
    """搜 A股/基金/指数（东财 suggest）；网络失败返回明确提示。"""
    kw = str(args.get("query") or "").strip()
    if not kw:
        return "需要提供搜索关键词，例如「茅台」「600519」"
    try:
        async with httpx.AsyncClient(timeout=4.0) as client:
            resp = await client.get(
                _SEARCH_URL,
                params={"input": kw, "type": "14", "token": "D43BF722C8E33BDC906FB84D85E326E8"},
                headers=_SEARCH_HEADERS,
            )
            resp.raise_for_status()
            data = (resp.json() or {}).get("data") or {}
        rows = ((data.get("QuotationCodeTable") or {}).get("Data") or [])[:8]
    except Exception:  # noqa: BLE001 — 搜索失败给可读提示
        return "搜索服务暂时不可用（网络或行情源问题），请稍后再试"
    lines = []
    for r in rows:
        code = str(r.get("Code") or "").strip()
        name = str(r.get("Name") or "").strip()
        if not code or not name:
            continue
        stype = str(r.get("SecurityTypeName") or "")
        kind = "基金" if "基金" in stype else ("指数" if "指" in stype else "股票")
        lines.append(f"{name}（{code}，{kind}）")
    if not lines:
        return f"没有找到「{kw}」，试试完整代码或名称"
    return "搜索结果：\n" + "\n".join(lines)


async def tool_get_quote(args: dict[str, Any]) -> str:
    """单只标的实时行情（东财优先、新浪备源）。"""
    symbol = str(args.get("symbol") or "").strip().upper()
    if not symbol:
        return "需要提供代码，例如 600519"
    q = await quote_now(symbol)
    if q is None:
        return f"无法获取 {symbol} 的行情（可能不是 A股/ETF，或网络不可用）"
    name = q.get("name") or symbol
    pct = q.get("change_pct")
    pct_txt = f"{pct:+.2f}%" if pct is not None else "—"
    src = {"eastmoney": "东财", "sina": "新浪"}.get(q.get("source"), q.get("source", ""))
    return f"{name}（{symbol}）现价 {q['price']}，涨跌 {pct_txt}（来源：{src}）"


async def tool_add_watchlist(args: dict[str, Any]) -> str:
    """把标的加入自选（无名称时自动取实时名称）。"""
    symbol = str(args.get("symbol") or "").strip().upper()
    if not symbol:
        return "需要提供代码，例如 600519"
    name = str(args.get("name") or "").strip()
    if not name:
        q = await quote_now(symbol)
        name = (q or {}).get("name") or symbol
    try:
        await db.add_watchlist(symbol, name, str(args.get("kind") or "股票"))
    except Exception as exc:  # noqa: BLE001
        return f"添加自选失败：{exc}"
    return f"已把 {name}（{symbol}）加入自选。可以继续问它的行情、K 线或风险。"


async def tool_remove_watchlist(args: dict[str, Any]) -> str:
    symbol = str(args.get("symbol") or "").strip().upper()
    if not symbol:
        return "需要提供代码"
    await db.delete_watchlist(symbol)
    return f"已把 {symbol} 移出自选"


async def tool_sell_position(args: dict[str, Any]) -> str:
    """卖出/减仓持仓：给出代码与数量（可省略数量=全部清仓）。"""
    symbol = str(args.get("symbol") or "").strip().upper()
    if not symbol:
        return "需要提供代码，例如 600519"
    positions = await db.list_positions()
    cur = next((p for p in positions if p["symbol"] == symbol), None)
    if cur is None:
        return f"持仓里没有 {symbol}，无需卖出。当前持仓：{', '.join(p['symbol'] for p in positions) or '（空）'}"
    try:
        shares = float(args.get("shares") or 0)
    except (TypeError, ValueError):
        shares = 0
    if shares <= 0 or shares >= cur["shares"]:
        await db.delete_position(symbol)
        return f"已清仓卖出 {cur['name']}（{symbol}）：{cur['shares']:g} 份全部平仓，持仓已移除。"
    new_shares = cur["shares"] - shares
    await db.add_position(
        {
            "symbol": cur["symbol"],
            "name": cur["name"],
            "kind": cur["kind"],
            "industry": cur["industry"],
            "shares": new_shares,
            "cost": cur["cost"],
            "last": cur["last"],
            "buy_date": cur.get("buy_date"),
            "fee": cur.get("fee", 0),
        }
    )
    return (
        f"已卖出 {cur['name']}（{symbol}）{shares:g} 份，剩余 {new_shares:g} 份（成本 {cur['cost']:g} 不变）。"
        "可在持仓页查看最新盈亏。"
    )


async def tool_trigger_morning_report(_args: dict[str, Any]) -> str:
    """触发生成今日晨报（组合+账本+目标体检，空库会提示没有数据）。"""
    try:
        result = await scheduler.generate_report()
    except Exception as exc:  # noqa: BLE001 — 手动触发失败要给可读错误
        return f"晨报生成失败：{type(exc).__name__}: {exc}"
    if result.get("skipped"):
        return "还没有足够的数据生成晨报（需要至少一条持仓或流水）。先记一笔账或添加持仓，我再来帮你体检。"
    return result.get("answer", "晨报已生成。") + "\n（已归档到「问AI」→ 晨报历史）"


async def tool_backup_now(_args: dict[str, Any]) -> str:
    """生成一份本地加密备份包（PBKDF2+Fernet），口令只展示这一次。"""
    data = await db.export_data()
    passphrase = secrets.token_urlsafe(9)
    payload = backup.encrypt_export(data, passphrase)
    import datetime as _dt

    path = BACKUP_DIR / f"xiaoman-backup-{_dt.datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    return (
        f"已生成本地加密备份：{path.name}\n"
        f"解密口令：{passphrase}（只显示这一次，请妥善保存，口令不落盘、丢失无法找回）\n"
        "恢复方法：设置 → 数据与状态 → 恢复备份，选择该文件并输入口令。"
    )


async def tool_set_setting(args: dict[str, Any]) -> str:
    """修改应用设置（涨跌颜色/默认首页/语言/数字格式/快捷建议/晨报时间）。"""
    key = str(args.get("key") or "").strip()
    value = args.get("value")
    if not key or value is None:
        return "需要提供 key 与 value，例如：改默认首页为持仓页、涨跌颜色改成绿涨红跌"
    raw = str(value)
    if key == "color_scheme" and raw not in ("cn", "us"):
        return "涨跌颜色只能是 cn（红涨绿跌）或 us（绿涨红跌）"
    if key == "default_tab" and raw not in ("overview", "holdings", "market", "ledger", "chat"):
        return "默认首页只能是 总览/持仓/行情/记账/问AI"
    if key == "lang" and raw not in ("zh", "en"):
        return "语言只能是 zh 或 en"
    if key in ("compact_numbers", "show_suggestions") and raw not in ("on", "off"):
        return f"{key} 只能是 on 或 off"
    if key == "morning_report_time":
        import re as _re

        if not _re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", raw):
            return "晨报时间需为 HH:MM（24 小时制）"
    try:
        await db.set_setting(key, raw)
    except Exception as exc:  # noqa: BLE001
        return f"设置失败：{exc}"
    await invalidate_quotes_cache()
    return f"已更新设置：{key} = {raw}（下次启动生效的部分已即时应用）。"


async def tool_get_watchlist(_args: dict[str, Any]) -> str:
    items = await db.list_watchlist()
    if not items:
        return "自选列表是空的。可以让我帮你搜索并添加，例如「帮我看看茅台并加入自选」"
    lines = []
    for i in items:
        q = await quote_now(i["symbol"])
        if q:
            pct = q.get("change_pct")
            pct_txt = f"{pct:+.2f}%" if pct is not None else "—"
            lines.append(f"{i['name']}（{i['symbol']}）现价 {q['price']} {pct_txt}")
        else:
            lines.append(f"{i['name']}（{i['symbol']}）行情暂不可用")
    return "你的自选：\n" + "\n".join(lines)


async def tool_record_position(args: dict[str, Any]) -> str:
    """记录一笔买入持仓（份额/成本/现价必填；现价可从实时行情自动补）。"""
    symbol = str(args.get("symbol") or "").strip().upper()
    if not symbol:
        return "需要提供代码，例如 600519"
    try:
        shares = float(args.get("shares") or 0)
        cost = float(args.get("cost") or 0)
        last = float(args.get("last") or 0)
    except (TypeError, ValueError):
        return "份额/成本/现价需要是数字"
    if shares <= 0 or cost <= 0:
        return "需要份额（>0）与成本价（>0）"
    if last <= 0:
        q = await quote_now(symbol)
        last = float((q or {}).get("price") or 0)
    if last <= 0:
        return "无法取得现价，请提供 last 现价"
    name = str(args.get("name") or "").strip()
    if not name:
        q = await quote_now(symbol)
        name = (q or {}).get("name") or symbol
    try:
        await db.add_position(
            {
                "symbol": symbol,
                "name": name,
                "kind": str(args.get("kind") or "股票"),
                "industry": str(args.get("industry") or "其他"),
                "shares": shares,
                "cost": cost,
                "last": last,
                "buy_date": str(args.get("buy_date") or "") or None,
                "fee": 0,
            }
        )
    except Exception as exc:  # noqa: BLE001
        return f"记录失败：{exc}"
    return (
        f"已记录买入 {name}（{symbol}）：{shares:g} 份 × 成本 {cost:g}，现价 {last:g}。"
        "可在总览/持仓页查看最新盈亏。"
    )


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
    {
        "type": "function",
        "function": {
            "name": "search_symbol",
            "description": "搜索 A股/基金/指数（按代码或名称，如「茅台」「600519」）。用于用户想了解某只标的但不知道代码，或要先找到标的再决定看行情/加自选。",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string", "description": "搜索关键词，代码或名称"}},
                "required": ["query"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_quote",
            "description": "查询单只标的实时行情：现价、涨跌幅、来源（东财/新浪）。适合「茅台现在多少钱」「今天涨了吗」等问题。",
            "parameters": {
                "type": "object",
                "properties": {"symbol": {"type": "string", "description": "6 位代码，如 600519"}},
                "required": ["symbol"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "add_to_watchlist",
            "description": "把某只标的加入自选（用户表达「关注/盯一下/加自选」时调用）。成功后用户可在行情页自选 Tab 看到。",
            "parameters": {
                "type": "object",
                "properties": {
                    "symbol": {"type": "string", "description": "6 位代码"},
                    "name": {"type": "string", "description": "标的名称（可省略，自动获取）"},
                    "kind": {"type": "string", "description": "股票/基金/指数"},
                },
                "required": ["symbol"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "remove_from_watchlist",
            "description": "把某只标的自自选移除（用户表达「不看了/移除自选」时调用）。",
            "parameters": {
                "type": "object",
                "properties": {"symbol": {"type": "string", "description": "6 位代码"}},
                "required": ["symbol"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_watchlist",
            "description": "查询用户自选列表及其实时行情。适合「我的自选现在怎么样」「自选里谁涨了」。",
            "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "record_position",
            "description": "记录一笔买入持仓（用户表达「买了/买入/建仓/补仓」并给出代码或名称与数量成本时调用）。成功后总览与持仓页自动更新。",
            "parameters": {
                "type": "object",
                "properties": {
                    "symbol": {"type": "string", "description": "6 位代码"},
                    "name": {"type": "string", "description": "名称（可省略，自动获取）"},
                    "kind": {"type": "string", "description": "股票/基金/ETF"},
                    "shares": {"type": "number", "description": "份额/股数"},
                    "cost": {"type": "number", "description": "成本价（买入价）"},
                    "last": {"type": "number", "description": "现价（可省略，自动获取）"},
                    "buy_date": {"type": "string", "description": "买入日期 YYYY-MM-DD，可省略默认今天"},
                },
                "required": ["symbol", "shares", "cost"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "sell_position",
            "description": "卖出/减仓持仓（用户表达「卖出/卖掉/清仓/减仓/抛售」并给出代码时调用；数量省略=全部清仓）。成功后持仓页自动更新。",
            "parameters": {
                "type": "object",
                "properties": {
                    "symbol": {"type": "string", "description": "6 位代码"},
                    "shares": {"type": "number", "description": "卖出份额/股数（省略=清仓全部）"},
                },
                "required": ["symbol"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "trigger_morning_report",
            "description": "立即生成今日晨报（组合+账本+财务目标体检）。用户说「生成晨报/今日晨报/帮我体检」时调用。空库会提示先有数据。",
            "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "backup_now",
            "description": "生成本地加密备份包（口令只显示一次）。用户说「备份/导出存档」时调用。",
            "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_setting",
            "description": "修改应用偏好：涨跌颜色 color_scheme（cn 红涨绿跌 / us 绿涨红跌）、默认首页 default_tab（overview/holdings/market/ledger/chat）、语言 lang（zh/en）、数字格式 compact_numbers、快捷建议 show_suggestions（on/off）、晨报时间 morning_report_time（HH:MM）。",
            "parameters": {
                "type": "object",
                "properties": {
                    "key": {"type": "string", "description": "设置键名，见工具描述"},
                    "value": {"type": "string", "description": "设置值，见工具描述"},
                },
                "required": ["key", "value"],
                "additionalProperties": False,
            },
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
    "search_symbol": tool_search_symbol,
    "get_quote": tool_get_quote,
    "add_to_watchlist": tool_add_watchlist,
    "remove_from_watchlist": tool_remove_watchlist,
    "get_watchlist": tool_get_watchlist,
    "record_position": tool_record_position,
    "sell_position": tool_sell_position,
    "trigger_morning_report": tool_trigger_morning_report,
    "backup_now": tool_backup_now,
    "set_setting": tool_set_setting,
}

# 工具返回体量上限：超过即截断（防止把整库明细喂给模型）
TOOL_RESULT_MAX_CHARS = 2500


def truncate_tool_result(text: str) -> str:
    if len(text) <= TOOL_RESULT_MAX_CHARS:
        return text
    return text[:TOOL_RESULT_MAX_CHARS] + "…（已截断，只保留关键数字）"


# ---------------------------------------------------------------------------
# 确定性动作执行：不配模型也能在对话里直接执行（卖出/晨报/备份）
# ---------------------------------------------------------------------------
_ACTION_STOP = {"卖出", "卖掉", "清仓", "减仓", "抛售", "全部", "帮我", "一下", "现在", "把"}


def _match_position_by_name(q: str, positions: list[dict[str, Any]]) -> dict[str, Any] | None:
    """名称匹配持仓：全名命中或任意两字连续命中（跳过动作/虚词），用于「清仓茅台」这类说法。"""
    for p in positions:
        name = (p.get("name") or "").strip()
        if not name:
            continue
        if name in q:
            return p
        for i in range(len(name) - 1):
            bigram = name[i : i + 2]
            if bigram in _ACTION_STOP:
                continue
            if bigram in q:
                return p
    return None


async def run_action(question: str, lang: str = "zh") -> dict[str, Any]:
    """对话内确定性动作：卖出/清仓/减仓 → sell_position；晨报 → 生成；备份 → 加密备份。
    返回与记账回执同构的 dict（answer/level/route/…/actions），供 agent 成文与前端跳转。"""
    q = question
    import re as _re

    if any(w in q for w in ("卖出", "卖掉", "清仓", "减仓", "抛售")):
        m = _re.search(r"(\d{6})", q)
        symbol = m.group(1) if m else ""
        if not symbol:
            matched = _match_position_by_name(q, await db.list_positions())
            if matched:
                symbol = matched["symbol"]
        if not symbol:
            return {
                "answer": "卖出需要告诉我代码（例如「卖出 600519」）或持仓名称（例如「清仓贵州茅台」）。",
                "level": "需要补充",
                "route": "action",
                "route_reason": "动作指令缺代码",
                "metrics": {},
                "flags": [],
                "llm": "tool",
                "actions": [{"tab": "holdings"}],
            }
        ans = await tool_sell_position({"symbol": symbol})
        return {
            "answer": ans,
            "level": "已执行",
            "route": "action",
            "route_reason": "卖出/清仓指令",
            "metrics": {},
            "flags": [],
            "llm": "tool",
            "tools_used": ["sell_position"],
            "actions": [{"tab": "holdings"}],
        }

    if "晨报" in q:
        ans = await tool_trigger_morning_report({})
        return {
            "answer": ans,
            "level": "已生成",
            "route": "action",
            "route_reason": "晨报指令",
            "metrics": {},
            "flags": [],
            "llm": "tool",
            "tools_used": ["trigger_morning_report"],
            "actions": [{"tab": "overview"}],
        }

    if "备份" in q:
        ans = await tool_backup_now({})
        return {
            "answer": ans,
            "level": "已执行",
            "route": "action",
            "route_reason": "备份指令",
            "metrics": {},
            "flags": [],
            "llm": "tool",
            "tools_used": ["backup_now"],
            "actions": [{"tab": "settings"}],
        }

    return {
        "answer": "这条指令我暂时还不能直接执行。你可以试试：卖出持仓（如「卖出 600519」）、生成晨报（「生成今日晨报」）或备份（「备份一下」）。",
        "level": "未识别",
        "route": "action",
        "route_reason": "动作指令未命中",
        "metrics": {},
        "flags": [],
        "llm": "tool",
        "actions": [],
    }
