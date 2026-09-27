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
    goals = goal_progress(await db.list_goals())

    return {
        "positions": m["positions"],
        "goals": goals,
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


# ---------------------------------------------------------------------------
# 财务目标 / 体检
# ---------------------------------------------------------------------------


def goal_progress(goals: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """目标进度：百分比、缺口、距截止月剩余月数、建议月存。纯函数，可单测。"""
    now = datetime.now()
    out: list[dict[str, Any]] = []
    for g in goals:
        target = _num(g.get("target"))
        saved = _num(g.get("saved"))
        pct = round(saved / target * 100, 1) if target > 0 else 0.0
        months_left = None
        deadline = str(g.get("deadline") or "").strip()
        if deadline and len(deadline) == 7:
            try:
                ym = datetime.strptime(deadline, "%Y-%m")
                months_left = max(
                    0, (ym.year - now.year) * 12 + (ym.month - now.month)
                )
            except ValueError:
                months_left = None
        gap = max(0.0, target - saved)
        monthly = round(gap / months_left, 2) if months_left else None
        out.append(
            {
                "name": g.get("name") or "",
                "target": target,
                "saved": saved,
                "pct": pct,
                "gap": round(gap, 2),
                "deadline": deadline,
                "months_left": months_left,
                "monthly_suggest": monthly,
                "done": target > 0 and saved >= target,
            }
        )
    return out


def health_check(
    market: dict[str, Any] | None,
    ledger: dict[str, Any] | None,
    flags: list[dict[str, Any]],
    goals: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """结构化财务体检：资产配置 / 现金流 / 负债 / 应急金 / 目标进度 五维评分。

    每维度返回 status（good/warn/bad）+ 一句 human 可读结论。纯函数，供工具与 REST 复用。
    """
    dims: list[dict[str, Any]] = []

    # 1) 资产配置
    conc = (market or {}).get("concentration") or {}
    breaches = conc.get("asset_breaches", [])
    if breaches:
        dims.append({
            "key": "portfolio",
            "title": "资产配置",
            "status": "warn",
            "detail": (
                f"总市值 {market['total_market_value']:,.0f} 元，存在 "
                f"{len(breaches)} 项集中度超限：{'、'.join(b['name'] for b in breaches[:3])}"
            ),
            "suggestion": "单一持仓/行业占比过高，考虑分散配置降低波动。",
        })
    elif market:
        m = market
        word = "浮盈" if m["total_pnl"] >= 0 else "浮亏"
        dims.append({
            "key": "portfolio",
            "title": "资产配置",
            "status": "good",
            "detail": (
                f"总市值 {m['total_market_value']:,.0f} 元，累计{word} {abs(m['total_pnl']):,.0f} 元，"
                "持仓集中度在阈值内，配置较为分散。"
            ),
            "suggestion": "",
        })

    # 2) 现金流 / 储蓄率
    if ledger:
        sr = ledger.get("savings_rate", 0)
        net = ledger.get("net", 0)
        if sr < SAVINGS_RATE_WARN_PCT:
            dims.append({
                "key": "cashflow",
                "title": "现金流",
                "status": "warn",
                "detail": f"本月结余 {net:,.0f} 元，储蓄率 {sr}% 低于建议线 {SAVINGS_RATE_WARN_PCT}%",
                "suggestion": "梳理非必要支出（可看支出分类），把储蓄率提到 20% 以上。",
            })
        elif sr >= 20:
            dims.append({
                "key": "cashflow",
                "title": "现金流",
                "status": "good",
                "detail": f"本月结余 {net:,.0f} 元，储蓄率 {sr}%，处于健康区间。",
                "suggestion": "",
            })

    # 3) 负债健康
    if ledger:
        dti = ledger.get("dti_pct", 0)
        high = ledger.get("high_rate_debts") or []
        if dti > DTI_WARN_PCT or high:
            dims.append({
                "key": "debt",
                "title": "负债健康",
                "status": "warn" if not high else "bad",
                "detail": f"负债月供占收入 {dti}%（建议线 {DTI_WARN_PCT}%）" + (f"，存在高息负债：{high[0]['name']}" if high else ""),
                "suggestion": "优先偿还高息负债（如信用卡分期），再考虑新增负债。",
            })
        elif ledger.get("debt_monthly", 0) == 0:
            dims.append({
                "key": "debt",
                "title": "负债健康",
                "status": "good",
                "detail": "当前无负债月供，财务结构干净。",
                "suggestion": "",
            })

    # 4) 应急金
    em = (ledger or {}).get("emergency") or {}
    if em.get("has_data"):
        ok = em.get("ok", True)
        dims.append({
            "key": "emergency",
            "title": "应急金",
            "status": "good" if ok else "warn",
            "detail": (
                f"应急金可覆盖 {em.get('months_covered')} 个月必要支出（目标 {em.get('target_months')} 个月）"
                if ok
                else f"应急金仅覆盖 {em.get('months_covered')} 个月，低于目标 {em.get('target_months')} 个月"
            ),
            "suggestion": "" if ok else "每月结余优先补足应急金，再谈其它目标。",
        })

    # 5) 目标进度
    gs = goal_progress(goals or [])
    if gs:
        done = [g for g in gs if g["done"]]
        on_going = [g for g in gs if not g["done"]]
        if on_going:
            slow = [g for g in on_going if g.get("months_left") and g["monthly_suggest"] and g["monthly_suggest"] > (ledger or {}).get("net", 0)]
            dims.append({
                "key": "goals",
                "title": "目标进度",
                "status": "warn" if slow else "good",
                "detail": (
                    f"{len(done)} 个目标已完成；"
                    + "、".join(f"{g['name']} {g['pct']}%" for g in on_going[:3])
                    + ("（按当前结余，部分目标可能赶不上截止日）" if slow else "")
                ),
                "suggestion": "" if not slow else "提高每月储蓄或延后目标截止月。",
            })
        else:
            dims.append({
                "key": "goals",
                "title": "目标进度",
                "status": "good",
                "detail": "全部目标已达成。",
                "suggestion": "",
            })

    flags_texts = [f["text"] for f in flags]
    if not dims:
        # 空库不给「整体健康 100 分」的假象：没有任何数据可评估
        return {
            "score": 0,
            "dimensions": [],
            "flags": flags_texts,
            "summary": "数据不足：记几笔账、加几条持仓后体检才有意义",
        }
    score = max(0, 100 - 20 * len([d for d in dims if d["status"] != "good"]))
    return {
        "score": min(100, score),
        "dimensions": dims,
        "flags": flags_texts,
        "summary": (
            "整体健康" if all(d["status"] == "good" for d in dims)
            else "有几项需要关注，按建议逐条处理即可"
        ),
    }


HEALTH_WORDS = ("体检", "健康检查", "哪里需要改进", "财务状况怎么样", "综合评分")


def health_report_text(report: dict[str, Any]) -> str:
    """把 health_check 报告转成给用户看的文本（确定性体检输出，无需模型）。"""
    lines = [f"财务体检综合评分 {report['score']} 分（{report['summary']}）。"]
    if not report["dimensions"]:
        lines.append("当前数据太少，暂时无法逐项评估——记几笔账、加几条持仓后体检会更完整。")
        return "\n".join(lines)
    for d in report["dimensions"]:
        status = {"good": "健康", "warn": "需关注", "bad": "风险"}.get(d["status"], d["status"])
        line = f"- {d['title']}（{status}）：{d['detail']}"
        if d.get("suggestion"):
            line += f"\n  建议：{d['suggestion']}"
        lines.append(line)
    return "\n".join(lines)
