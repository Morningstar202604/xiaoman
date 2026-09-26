"""确定性分析内核：持仓、现金流、负债、应急金、风控规则。

原则：数字只来自数据，规则永远比模型可靠。模型只负责把这里的结果"讲成人话"，
模板叙述则保证无模型时也能给出完整、可复核的回答。

本模块不碰网络（行情由 quotes 层负责），纯函数均可单测。
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from . import db, quotes

DISCLAIMER = "以上为基于你的组合与账本数据的洞察，不构成投资建议。"
CONCENTRATION_MAX_PCT = 40.0
DTI_WARN_PCT = 40.0
SAVINGS_RATE_WARN_PCT = 20.0
HIGH_RATE_DEBT = 0.08


def _month_prefix() -> str:
    return datetime.now().strftime("%Y-%m")


# --------------------------------------------------------------------------
# 市场视角
# --------------------------------------------------------------------------


def market_view(
    positions: list[dict[str, Any]], live: dict[str, float]
) -> dict[str, Any]:
    """持仓明细 + 市值/盈亏 + 集中度（按标的、按行业）。"""
    rows, total_mv, total_cost = [], 0.0, 0.0
    for p in positions:
        last = live.get(p["symbol"], float(p["last"]))
        mv = p["shares"] * last
        cost = p["shares"] * p["cost"]
        total_mv += mv
        total_cost += cost
        rows.append(
            {
                "symbol": p["symbol"],
                "name": p["name"],
                "kind": p["kind"],
                "industry": p["industry"],
                "shares": p["shares"],
                "last": round(last, 4),
                "market_value": round(mv, 2),
                "cost": round(cost, 2),
                "pnl": round(mv - cost, 2),
                "pnl_pct": round((mv - cost) / cost * 100, 2) if cost else 0.0,
            }
        )

    by_asset = []
    for r in rows:
        if total_mv:
            by_asset.append(
                {
                    "name": r["name"],
                    "kind": r["kind"],
                    "pct": round(r["market_value"] / total_mv * 100, 1),
                }
            )
    by_asset.sort(key=lambda x: -x["pct"])

    agg: dict[str, float] = {}
    for r in rows:
        agg[r["industry"]] = agg.get(r["industry"], 0.0) + r["market_value"]
    by_industry = [
        {"industry": k, "pct": round(v / total_mv * 100, 1) if total_mv else 0.0}
        for k, v in sorted(agg.items(), key=lambda kv: -kv[1])
    ]

    return {
        "positions": rows,
        "total_market_value": round(total_mv, 2),
        "total_cost": round(total_cost, 2),
        "total_pnl": round(total_mv - total_cost, 2),
        "total_pnl_pct": round((total_mv - total_cost) / total_cost * 100, 2)
        if total_cost
        else 0.0,
        "concentration": {
            "threshold_pct": CONCENTRATION_MAX_PCT,
            "by_asset": by_asset,
            "by_industry": by_industry,
            "asset_breaches": [
                a
                for a in by_asset
                if a["pct"] > CONCENTRATION_MAX_PCT and a["kind"] != "现金"
            ],
            "industry_breaches": [
                i
                for i in by_industry
                if i["pct"] > CONCENTRATION_MAX_PCT and i["industry"] != "现金"
            ],
        },
    }


# --------------------------------------------------------------------------
# 账本视角
# --------------------------------------------------------------------------


def ledger_view(
    transactions: list[dict[str, Any]],
    subscriptions: list[dict[str, Any]],
    debts: list[dict[str, Any]],
    settings: dict[str, str],
    positions: list[dict[str, Any]],
    live: dict[str, float],
) -> dict[str, Any]:
    """本月现金流 + 订阅 + 负债 + 应急金。所有"本月"口径都按 date 前缀过滤。"""
    month = _month_prefix()
    txs = [t for t in transactions if str(t.get("date", "")).startswith(month)]

    income = sum(t["amount"] for t in txs if t["amount"] > 0)
    expense = sum(-t["amount"] for t in txs if t["amount"] < 0)
    by_cat: dict[str, float] = {}
    for t in txs:
        if t["amount"] < 0:
            by_cat[t["category"]] = by_cat.get(t["category"], 0.0) + -t["amount"]
    ranked = sorted(by_cat.items(), key=lambda kv: -kv[1])

    subs_total = sum(s["monthly"] for s in subscriptions)
    income_num = _num(settings.get("monthly_income"))
    debt_monthly = sum(d["monthly"] for d in debts)
    dti = round(debt_monthly / income_num * 100, 1) if income_num else 0.0

    cash = sum(
        p["shares"] * live.get(p["symbol"], float(p["last"]))
        for p in positions
        if p["kind"] == "现金"
    )
    cats = [
        c.strip()
        for c in settings.get("essential_categories", "居住,餐饮,交通").split(",")
        if c.strip()
    ]
    essential = sum(
        -t["amount"] for t in txs if t["amount"] < 0 and t["category"] in cats
    )
    target = _num(settings.get("emergency_target_months"))
    has_data = essential > 0
    months = round(cash / essential, 1) if essential else 0.0

    return {
        "month": month,
        "income": round(income, 2),
        "expense": round(expense, 2),
        "net": round(income - expense, 2),
        "savings_rate": round((income - expense) / income * 100, 1) if income else 0.0,
        "by_category": [{"category": k, "amount": round(v, 2)} for k, v in ranked[:6]],
        "subscription_monthly": round(subs_total, 2),
        "subscription_annual": round(subs_total * 12, 2),
        "debt_monthly": round(debt_monthly, 2),
        "dti_pct": dti,
        "high_rate_debts": [d for d in debts if d["rate"] >= HIGH_RATE_DEBT],
        "emergency": {
            "cash": round(cash, 2),
            "essential_monthly": round(essential, 2),
            "essential_categories": cats,
            "months_covered": months,
            "target_months": target,
            "has_data": has_data,
            "ok": (months >= target if target else True) if has_data else True,
        },
    }


def _num(raw: Any, default: float = 0.0) -> float:
    try:
        return float(raw or 0)
    except (TypeError, ValueError):
        return default


# --------------------------------------------------------------------------
# 风控规则（确定性，不依赖模型）
# --------------------------------------------------------------------------


def risk_checks(
    market: dict[str, Any] | None, ledger: dict[str, Any] | None
) -> list[dict[str, str]]:
    flags: list[dict[str, str]] = []

    if market:
        conc = market.get("concentration") or {}
        for b in conc.get("asset_breaches", []):
            flags.append(
                {
                    "level": "warn",
                    "code": "CONCENTRATION",
                    "text": f"{b['name']} 占比 {b['pct']}% 超过 {conc.get('threshold_pct')}% 单一持仓阈值",
                }
            )
        for b in conc.get("industry_breaches", []):
            flags.append(
                {
                    "level": "warn",
                    "code": "CONCENTRATION",
                    "text": f"{b['industry']} 行业占比 {b['pct']}% 超过 {conc.get('threshold_pct')}% 阈值",
                }
            )

    if ledger:
        em = ledger.get("emergency") or {}
        if em and em.get("has_data") and not em.get("ok"):
            flags.append(
                {
                    "level": "warn",
                    "code": "EMERGENCY_FUND",
                    "text": f"应急金仅覆盖 {em.get('months_covered')} 个月，低于 {em.get('target_months')} 个月目标",
                }
            )
        for d in ledger.get("high_rate_debts", []):
            flags.append(
                {
                    "level": "warn",
                    "code": "HIGH_RATE_DEBT",
                    "text": f"{d['name']} 利率 {d['rate'] * 100:.1f}%，属高息负债",
                }
            )
        if ledger.get("dti_pct", 0) > DTI_WARN_PCT:
            flags.append(
                {
                    "level": "warn",
                    "code": "DTI",
                    "text": f"负债收入比 {ledger['dti_pct']}% 超过 {DTI_WARN_PCT:.0f}% 警戒线",
                }
            )
        # 无收入记录时储蓄率不可计算，报「0% 偏低」是数据缺失的伪信号
        if ledger.get("income", 0) > 0 and ledger.get("savings_rate", 100) < SAVINGS_RATE_WARN_PCT:
            flags.append(
                {
                    "level": "warn",
                    "code": "SAVINGS_RATE",
                    "text": f"储蓄率 {ledger.get('savings_rate')}% 偏低（建议不低于 {SAVINGS_RATE_WARN_PCT:.0f}%）",
                }
            )
    return flags


# --------------------------------------------------------------------------
# 模板叙述（无模型时的完整回答；模型存在时用于兜底）
# --------------------------------------------------------------------------


NO_DATA_ANSWER = (
    "你还没有录入任何数据，所以我给不出数字。现在可以做的是：\n"
    "- 去「记账」用一句话记一笔（例如「昨天打车 32 元」）；\n"
    "- 或添加持仓后，我帮你算盈亏、集中度和风险。\n"
    "录入之后，这些问题就能直接回答：我的钱花到哪了、持仓有什么风险、应急金够不够。"
)


def template_answer(
    market: dict[str, Any] | None,
    ledger: dict[str, Any] | None,
    flags: list[dict[str, str]],
    has_data: bool = True,
) -> str:
    # 空库不给零值报告（「总市值 0 元 + 储蓄率 0% 偏低」是新用户劝退组合）
    if not has_data:
        return NO_DATA_ANSWER

    parts: list[str] = []

    if market:
        m = market
        word = "浮盈" if m["total_pnl"] >= 0 else "浮亏"
        line = (
            f"你的组合总市值 {m['total_market_value']:,.0f} 元，{word} "
            f"{abs(m['total_pnl']):,.0f} 元（{m['total_pnl_pct']}%）。"
        )
        conc = m["concentration"]
        if conc["by_asset"]:
            top = conc["by_asset"][0]
            note = f"最大单一持仓 {top['name']} 占 {top['pct']}%。"
            if top["pct"] > conc["threshold_pct"]:
                note += f" 已超过 {conc['threshold_pct']}% 集中度阈值。"
            line += note
        parts.append(line)

    if ledger:
        ld = ledger
        em = ld["emergency"]
        if em.get("has_data"):
            em_line = f"应急金可覆盖 {em['months_covered']} 个月（目标 {em['target_months']} 个月）。"
        else:
            em_line = f"本月暂无必要支出记录，应急金（现金 {em['cash']:,.0f} 元）覆盖月数暂无法估算。"
        parts.append(
            f"{ld['month']} 收入 {ld['income']:,.0f} 元、支出 {ld['expense']:,.0f} 元，"
            f"结余 {ld['net']:,.0f} 元（储蓄率 {ld['savings_rate']}%）。"
            f"订阅月支出 {ld['subscription_monthly']:,.0f} 元，"
            f"负债月供 {ld['debt_monthly']:,.0f} 元（占收入 {ld['dti_pct']}%），"
            f"{em_line}"
        )

    if flags:
        parts.append(
            "发现 "
            + str(len(flags))
            + " 项需关注："
            + "；".join(f["text"] for f in flags)
            + "。"
        )
    else:
        parts.append("未发现明显风险项，当前财务状况整体稳健。")

    return "\n\n".join(parts)


# --------------------------------------------------------------------------
# 一站式：取数 + 计算（供服务层与 /api/dashboard 共用）
# --------------------------------------------------------------------------


async def collect_dashboard() -> dict[str, Any]:
    """仪表盘所需全部数据：持仓/账本/负债/风控/来源。"""
    positions = await db.list_positions()
    live = await quotes.live_quotes(positions)
    settings = await db.get_settings()
    mode = settings.get("quote_source_mode", "auto")

    # 行情源标注：快照模式固定标快照；auto/eastmoney 按本次实际生效来源标注
    if mode == "snapshot":
        quotes_label = "组合库快照价"
    elif quotes.last_source() == "eastmoney":
        quotes_label = "东方财富实时价"
    else:
        quotes_label = "组合库快照价（实时源不可用，自动降级）"

    m = market_view(positions, live)
    txs = await db.list_transactions()
    subs = await db.list_subscriptions()
    debts = await db.list_debts()
    led = ledger_view(txs, subs, debts, settings, positions, live)
    flags = risk_checks(m, led)

    return {
        "positions": m["positions"],
        "totals": {
            "total_market_value": m["total_market_value"],
            "total_cost": m["total_cost"],
            "total_pnl": m["total_pnl"],
            "total_pnl_pct": m["total_pnl_pct"],
        },
        "concentration": m["concentration"],
        "cashflow": {
            k: led[k]
            for k in (
                "month",
                "income",
                "expense",
                "net",
                "savings_rate",
                "by_category",
            )
        },
        "subscriptions": {
            "items": subs,
            "monthly_total": led["subscription_monthly"],
            "annual_total": led["subscription_annual"],
        },
        "debts": {
            "items": debts,
            "monthly_total": led["debt_monthly"],
            "dti_pct": led["dti_pct"],
        },
        "emergency": led["emergency"],
        "flags": flags,
        "transactions": txs,
        "source": {
            "portfolio": "本地组合库（SQLite）",
            "ledger": "本地账本（SQLite）",
            "quotes": quotes_label,
            "seeded": settings.get("data_note", "seed") != "user",
        },
    }
