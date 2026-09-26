"""问答服务：把用户的提问跑成一份可复核的财务回答。

替代旧的 LangGraph 编排——这里就是一段清晰的异步顺序流程：
  分类意图 → 取数分析（并行收集市场/账本视角）→ 风控复核 → 成文（流式）

事件契约（SSE，由 main.py 转发给前端）：
  {"type":"start","question":...}
  {"type":"step","id":"market","label":"查看持仓","detail":"...","phase":"start|done"}
  {"type":"text","delta":"..."}          # 成文增量（LLM 流式 或 模板一次给出）
  {"type":"final","answer":...,"level":...,"route":...,"metrics":{...},"flags":[...],"llm":"llm|template"}
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from typing import Any

from . import analysis, db, llm, nlparse
from .quotes import live_quotes

Emit = Callable[[dict[str, Any]], Awaitable[None]]

MARKET_WORDS = ("股票", "基金", "持仓", "仓位", "组合", "收益", "亏", "涨", "跌", "etf", "市值", "资产", "集中度", "配置")
LEDGER_WORDS = ("花", "支出", "记账", "账", "预算", "订阅", "会员", "还款", "负债", "房贷", "信用卡", "现金流", "存", "省", "应急金", "储蓄", "收入", "余额", "工资")

GENERAL_SYSTEM = (
    "你是一个通用 AI 助手，同时具备个人理财工具的能力。"
    "普通问题（写作、翻译、编程、闲聊等）直接正常回答；"
    "遇到与用户财务相关的问题，如实说明你还没有该问题的数据，"
    "并提示可以在应用里记账或添加持仓后再问。不要编造任何数字。"
)
GENERAL_FALLBACK = (
    "当前没有接入模型，自由问答需要先到「设置 → AI 回答」配置模型端点。"
    "不过记账和确定性分析我离线就能做：去「记账」一句话记一笔，"
    "或问我持仓、收支、负债与风险。"
)

# 疑问/讨论式句式黑名单：命中则不当记账指令，避免把「花了3000怎么办」写进账本
QUESTION_MARKS = ("吗", "呢", "怎", "哪", "多少", "是不是", "?", "？")
NL_MAX_LEN = 24


def _looks_like_record(question: str) -> bool:
    """短句 + 无疑问词 + 能解析出金额 → 视为一句话记账指令。"""
    q = question.strip()
    if not q or len(q) > NL_MAX_LEN:
        return False
    return not any(m in q for m in QUESTION_MARKS)


async def _try_nl_add(question: str, reason: str, emit: Emit) -> dict[str, Any] | None:
    """对话内一句话记账：规则解析（无需模型）→ 入账 → 回执（含撤销路径）。"""
    if not _looks_like_record(question):
        return None
    parsed = nlparse.parse(question)
    if parsed is None:
        return None

    await emit({
        "type": "step", "id": "nl", "label": "识别记账",
        "detail": f"{parsed['item']} {abs(parsed['amount']):.2f} 元（{parsed['category']}）", "phase": "start",
    })
    ins = await db.add_transaction(
        parsed["date"], parsed["item"], parsed["category"], parsed["amount"]
    )
    direction = "收入" if parsed["amount"] > 0 else "支出"
    answer = (
        f"已记一笔：{parsed['date']} {parsed['item']} {abs(parsed['amount']):,.2f} 元"
        f"（{parsed['category']} · {direction}）。\n\n"
        "记错了可以在「记账」页删掉这一条。"
    )
    await emit({
        "type": "step", "id": "nl", "label": "已入账",
        "detail": f"{parsed['category']} {abs(parsed['amount']):,.2f} 元", "phase": "done",
    })
    return {
        "answer": answer,
        "level": "已记账",
        "route": "nl_add",
        "route_reason": f"识别为一句话记账：{reason}",
        "metrics": {},
        "flags": [],
        "llm": "template",
        "tx_id": ins["id"],
    }


def route_question(question: str) -> tuple[str, str]:
    """规则分类（不调模型）：命中投资词 → market，命中收支词 → ledger，都命中 → both，都不命中 → general。

    宁缺毋滥：不确定是否问财务时一律 general，绝不做「猜测式财务综合分析」。
    """
    q = question.lower()
    hit_m = [w for w in MARKET_WORDS if w in q]
    hit_l = [w for w in LEDGER_WORDS if w in q]
    if hit_m and hit_l:
        return "both", f"同时涉及持仓({hit_m[0]})与收支({hit_l[0]})"
    if hit_m:
        return "market", f"涉及持仓/行情（{hit_m[0]}）"
    if hit_l:
        return "ledger", f"涉及收支/负债（{hit_l[0]}）"
    return "general", "未命中财务关键词，按通用问答处理"


async def _run_general(question: str, reason: str, emit: Emit) -> dict[str, Any]:
    """通用问答：跳过取数与风控，不注入也不外发任何财务数据，不拼财务免责声明。"""
    await emit({
        "type": "step", "id": "supervisor", "label": "理解问题",
        "detail": f"{reason}，直接回答", "phase": "done",
    })
    await emit({"type": "step", "id": "finalize", "label": "整理成文", "detail": "生成回答", "phase": "start"})

    user = json.dumps({"question": question}, ensure_ascii=False)
    chunks: list[str] = []
    src = "template"
    async for delta, s in llm.stream_narrate(GENERAL_SYSTEM, user, GENERAL_FALLBACK):
        src = s
        chunks.append(delta)
        await emit({"type": "text", "delta": delta})

    await emit({"type": "step", "id": "finalize", "label": "整理成文", "detail": "已完成", "phase": "done"})
    return {
        "answer": "".join(chunks).strip() or GENERAL_FALLBACK,
        "level": "L0 通用",
        "route": "general",
        "route_reason": reason,
        "metrics": {},
        "flags": [],
        "llm": src,
    }


async def run_question(question: str, emit: Emit) -> dict[str, Any]:
    """执行一轮问答，返回最终元信息（由调用方负责归档与转发 final 事件）。"""
    await emit({"type": "start", "question": question})

    route, reason = route_question(question)

    # 一句话记账优先：短句且能解析出金额时直接入账（无需模型），不进入问答链路
    recorded = await _try_nl_add(question, reason, emit)
    if recorded is not None:
        return recorded

    if route == "general":
        return await _run_general(question, reason, emit)

    await emit({
        "type": "step", "id": "supervisor", "label": "理解问题",
        "detail": f"{reason}，开始分析", "phase": "done",
    })

    routes = ["market", "ledger"] if route == "both" else [route]
    market = ledger = None

    # 取数分析（市场 / 账本视角共用同一份行情）
    positions = await db.list_positions()
    live = await live_quotes(positions)
    has_data = bool(positions) or bool(await db.fetch_all("SELECT 1 FROM transactions LIMIT 1"))

    if "market" in routes:
        await emit({"type": "step", "id": "market", "label": "查看持仓", "detail": "拉取持仓与行情，计算盈亏与集中度", "phase": "start"})
        market = analysis.market_view(positions, live)
        await emit({"type": "step", "id": "market", "label": "查看持仓", "detail": f"总市值 {market['total_market_value']:,.0f} 元，累计{'浮盈' if market['total_pnl'] >= 0 else '浮亏'} {abs(market['total_pnl']):,.0f} 元", "phase": "done"})

    if "ledger" in routes:
        await emit({"type": "step", "id": "ledger", "label": "核对账本", "detail": "汇总本月收支、订阅、负债与应急金", "phase": "start"})
        settings = await db.get_settings()
        ledger = analysis.ledger_view(
            await db.list_transactions(),
            await db.list_subscriptions(),
            await db.list_debts(),
            settings,
            positions,
            live,
        )
        await emit({"type": "step", "id": "ledger", "label": "核对账本", "detail": f"本月结余 {ledger['net']:,.0f} 元，负债月供 {ledger['debt_monthly']:,.0f} 元", "phase": "done"})

    flags = analysis.risk_checks(market, ledger)
    if flags:
        await emit({
            "type": "step", "id": "risk", "label": "风险复核",
            "detail": f"发现 {len(flags)} 项需关注：" + "；".join(f["text"] for f in flags[:2]),
            "phase": "done",
        })
    else:
        await emit({"type": "step", "id": "risk", "label": "风险复核", "detail": "未发现明显风险项", "phase": "done"})

    # 成文：模型润色（流式）→ 模板兜底
    level = "L2 建议" if flags else "L1 洞察"
    fallback = analysis.template_answer(market, ledger, flags, has_data=has_data)
    system = (
        "你是用户的个人理财助手。根据给定的持仓与账本数据，用简洁的中文回答用户的问题："
        "先一句话给结论，再分点列出关键数字，最后提示风险项（如有）。"
        "不要编造任何未给出的数字，不要给出具体买卖指令。"
    )
    user = json.dumps({
        "question": question,
        "market": market,
        "ledger": ledger,
        "flags": flags,
        "level": level,
    }, ensure_ascii=False)

    await emit({"type": "step", "id": "finalize", "label": "整理成文", "detail": "汇总结论与数字", "phase": "start"})

    chunks: list[str] = []
    src = "template"
    async for delta, s in llm.stream_narrate(system, user, fallback):
        src = s
        chunks.append(delta)
        await emit({"type": "text", "delta": delta})

    answer = "".join(chunks).strip() or fallback
    if analysis.DISCLAIMER not in answer:
        answer = answer + "\n\n— " + analysis.DISCLAIMER

    await emit({"type": "step", "id": "finalize", "label": "整理成文", "detail": "已完成", "phase": "done"})

    metrics = {}
    if market:
        metrics.update({
            "total_market_value": market["total_market_value"],
            "total_pnl": market["total_pnl"],
            "total_pnl_pct": market["total_pnl_pct"],
        })
    if ledger:
        metrics.update({
            "net": ledger["net"],
            "savings_rate": ledger["savings_rate"],
            "debt_monthly": ledger["debt_monthly"],
            "dti_pct": ledger["dti_pct"],
        })

    return {
        "answer": answer,
        "level": level,
        "route": route,
        "route_reason": reason,
        "metrics": metrics,
        "flags": flags,
        "llm": src,
    }
