"""LangGraph 多智能体编排图 —— 主执行路径（service.run_question 的图化替代）。

节点（每个都是独立 agent 角色，后续可独立扩展/替换）：
  supervisor     意图分类 agent：LLM 分类优先、规则兜底；一句话记账检测
  record         记账 agent：确定性入账（规则秒回，无需模型）
  general        通用 agent：不带任何财务数据出机（隐私边界不变）
  collect_market 市场 agent：持仓/行情/盈亏/集中度（确定性内核）
  collect_ledger 账本 agent：收支/结余/负债/应急金（确定性内核）
  risk           风控 agent：集中度/应急金/高息负债/DTI/储蓄率告警
  finalize       成文 agent：有模型 → function calling 工具循环；无模型 → 模板成文

设计原则：
- 图负责"编排"（谁先谁后、状态流转、条件分支），**数字仍由 analysis 确定性内核计算**；
- 模型只出现在 supervisor（分类）与 finalize（成文/工具调用），且任一失败自动降级：
  无模型 = 图照跑，所有 agent 节点走确定性实现，输出与旧流程完全一致；
- 事件契约不变（start/step/agent_step/text/final/done），SSE 协议零改动；
- 数据层是单连接 aiosqlite，节点间用顺序边（多 agent 结构在，不做跨节点并发，避免撞库）。

LangGraph 1.x 关键用法：StateGraph 状态机 + add_conditional_edges 条件路由 +
节点返回 partial update 自动合并；模型/工具调用仍是项目自有的 llm.py / tools.py
（openai 3.x 已适配），不引入 langchain-openai，避免版本耦合。
"""

from __future__ import annotations

import json
import logging
from collections.abc import Awaitable, Callable
from contextvars import ContextVar
from typing import Any, TypedDict

from langgraph.graph import END, START, StateGraph

from . import agent, analysis, db, llm, nlparse, service, tools
from .quotes import live_quotes

log = logging.getLogger(__name__)

Emit = Callable[[dict[str, Any]], Awaitable[None]]

# 节点内实时发 SSE 事件：ContextVar 按 asyncio task 隔离，并发请求互不串扰
_emit_ctx: ContextVar[Emit | None] = ContextVar("wo_emit", default=None)


async def _emit(ev: dict[str, Any]) -> None:
    e = _emit_ctx.get()
    if e is not None:
        await e(ev)


class AgentState(TypedDict, total=False):
    question: str
    thread_id: str | None
    lang: str  # 界面语言：zh | en（回答与确定性兜底文案跟随）
    route: str
    reason: str
    mode: str  # agent | deterministic
    routes: list[str]
    market: dict[str, Any] | None
    ledger: dict[str, Any] | None
    flags: list[dict[str, Any]]
    has_data: bool
    parsed: dict[str, Any] | None
    result: dict[str, Any]
    # collect_market 写入、collect_ledger / finalize 复用：避免同一轮持仓+行情被重复拉取
    positions: list[dict[str, Any]] | None
    live: dict[str, float] | None


# ---------------------------------------------------------------------------
# 节点实现
# ---------------------------------------------------------------------------


async def supervisor(state: AgentState) -> dict[str, Any]:
    """意图分类 + 记账检测。LLM 分类失败/未接入一律规则兜底。"""
    q = state["question"]
    tid = state.get("thread_id")

    route, reason = service.route_question(q)
    if route == "general" and await service._is_finance_followup(q, tid):
        route, reason = "both", "承接上一轮财务提问的省略追问"

    # 动作指令优先（卖出/清仓/晨报/备份）：先于记账检测，否则「卖出 600519」
    # 这类带数字的动作会被 nlparse 当成一笔支出记进账本（语义劫持）。
    if route == "action":
        return {"route": "action", "reason": reason, "mode": "deterministic"}

    # 记忆指令其次（先于记账）：「记住/记得 …」明确是记忆意图，
    # 否则「记住我下个月要交房租 5000」会被一句话记账当成支出入账。
    if service._looks_like_memory(q):
        return {"route": "memory", "reason": "识别为记忆指令，直接存长期记忆", "mode": "deterministic"}

    # 一句话记账：短句 + 能解析出金额 → 记账 agent（规则秒回，不调模型）
    parsed = None
    if service._looks_like_record(q):
        parsed = nlparse.parse(q)
    if parsed is not None:
        return {"route": "bookkeeping", "reason": reason, "parsed": parsed}

    if route == "general":
        return {"route": "general", "reason": reason, "mode": "deterministic"}

    mode = "agent" if await llm.llm_available() else "deterministic"
    # goal 路由（目标/体检）需要完整财务数据：市场 + 账本都查
    routes = ["market", "ledger"] if route in ("both", "goal") else [route]

    # 确定性模式发"理解问题"步骤；agent 模式不发（工具调用过程即说明，避免重复）
    if mode == "deterministic":
        await _emit({
            "type": "step", "id": "supervisor", "label": "理解问题",
            "detail": f"{reason}，开始分析", "phase": "done",
        })
    return {"route": route, "reason": reason, "mode": mode, "routes": routes}


async def record(state: AgentState) -> dict[str, Any]:
    """记账 agent：把一句话记账指令确定性入账并回执（复用 service._try_nl_add 唯一实现）。"""
    parsed = state["parsed"]
    assert parsed is not None
    result = await service._try_nl_add(state["question"], state["reason"], _emit, state.get("lang", "zh"))
    assert result is not None
    result.setdefault("actions", [{"tab": "ledger"}])
    return {"result": result}


async def action(state: AgentState) -> dict[str, Any]:
    """动作 agent：不配模型也能直接执行的动作指令（卖出/清仓、晨报、备份）。"""
    result = await tools.run_action(state["question"], state.get("lang", "zh"))
    return {"result": result}


async def memory(state: AgentState) -> dict[str, Any]:
    """记忆 agent：把「记住/记得 …」指令确定性写入长期记忆并回执（规则级，无需模型）。"""
    result = await service._try_save_memory(state["question"], _emit)
    assert result is not None
    return {"result": result}


async def collect_market(state: AgentState) -> dict[str, Any]:
    """市场 agent：持仓/行情/盈亏/集中度。确定性模式发步骤事件。"""
    if "market" not in (state.get("routes") or []):
        return {}
    if state.get("mode") == "deterministic":
        await _emit({"type": "step", "id": "market", "label": "查看持仓", "detail": "拉取持仓与行情，计算盈亏与集中度", "phase": "start"})
    positions = await db.list_positions()
    live = await live_quotes(positions)
    market = analysis.market_view(positions, live)
    if state.get("mode") == "deterministic":
        await _emit({
            "type": "step", "id": "market", "label": "查看持仓",
            "detail": f"总市值 {market['total_market_value']:,.0f} 元，累计{'浮盈' if market['total_pnl'] >= 0 else '浮亏'} {abs(market['total_pnl']):,.0f} 元",
            "phase": "done",
        })
    # positions/live 写入 state 供 collect_ledger、finalize 复用（同轮只拉一次）
    return {"market": market, "positions": positions, "live": live}


async def collect_ledger(state: AgentState) -> dict[str, Any]:
    """账本 agent：收支/结余/负债/应急金。确定性模式发步骤事件。"""
    if "ledger" not in (state.get("routes") or []):
        return {}
    if state.get("mode") == "deterministic":
        await _emit({"type": "step", "id": "ledger", "label": "核对账本", "detail": "汇总本月收支、订阅、负债与应急金", "phase": "start"})
    positions = state.get("positions")
    if positions is None:
        positions = await db.list_positions()
    live = state.get("live")
    if live is None:
        live = await live_quotes(positions)
    settings = await db.get_settings()
    ledger = analysis.ledger_view(
        await db.list_transactions(),
        await db.list_subscriptions(),
        await db.list_debts(),
        settings,
        positions,
        live,
    )
    if state.get("mode") == "deterministic":
        await _emit({
            "type": "step", "id": "ledger", "label": "核对账本",
            "detail": f"本月结余 {ledger['net']:,.0f} 元，负债月供 {ledger['debt_monthly']:,.0f} 元",
            "phase": "done",
        })
    return {"ledger": ledger}


async def risk(state: AgentState) -> dict[str, Any]:
    """风控 agent：跑规则告警。确定性模式发步骤事件。"""
    flags = analysis.risk_checks(state.get("market"), state.get("ledger"))
    if state.get("mode") == "deterministic":
        if flags:
            await _emit({
                "type": "step", "id": "risk", "label": "风险复核",
                "detail": f"发现 {len(flags)} 项需关注：" + "；".join(f["text"] for f in flags[:2]),
                "phase": "done",
            })
        else:
            await _emit({"type": "step", "id": "risk", "label": "风险复核", "detail": "未发现明显风险项", "phase": "done"})
    return {"flags": flags}


async def general(state: AgentState) -> dict[str, Any]:
    """通用 agent：复用既有通用路径（带同会话记忆、不带财务数据）。"""
    result = await service._run_general(
        state["question"], state["reason"], _emit, state.get("thread_id"), state.get("lang", "zh")
    )
    return {"result": result}


async def finalize(state: AgentState) -> dict[str, Any]:
    """成文 agent：有模型 → function calling 工具循环；无模型 → 模板成文（流式）。"""
    q = state["question"]
    tid = state.get("thread_id")
    routes = state.get("routes") or []
    market = state.get("market")
    ledger = state.get("ledger")
    flags = state.get("flags") or []
    # 空数据判定与旧流程一致：没有任何持仓且没有任何流水 → 引导记账（不是零值假象）
    positions = state.get("positions")
    if positions is None:
        positions = await db.list_positions()
    if state.get("mode") != "agent":
        has_data = bool(positions) or bool(
            await db.fetch_all("SELECT 1 FROM transactions LIMIT 1")
        )
    else:
        has_data = True  # agent 模式由模型自行判断数据有无
    route = state.get("route") or "both"
    reason = state.get("reason") or ""

    if state.get("mode") == "agent":
        # agent 模式：模型自主调用工具取数成文（工具数字仍来自本地确定性计算）。
        # 模型不可用/调用失败抛 AgentUnavailable → 图内降级确定性模板成文（不中断、不冒充）。
        try:
            history = await service._build_history(tid)
            result = await agent.run_agent(q, _emit, history, state.get("lang", "zh"))
            live = state.get("live")
            if live is None:
                live = await live_quotes(positions)
            m = analysis.market_view(positions, live) if "market" in routes else market
            led = (
                analysis.ledger_view(
                    await db.list_transactions(),
                    await db.list_subscriptions(),
                    await db.list_debts(),
                    await db.get_settings(),
                    positions,
                    live,
                )
                if "ledger" in routes
                else ledger
            )
            flags = analysis.risk_checks(m, led)
            level = "L2 建议" if flags else "L1 洞察"
            answer = result["answer"].strip()
            if analysis.DISCLAIMER not in answer:
                answer = answer + "\n\n— " + analysis.DISCLAIMER
            return {
                "result": {
                    "answer": answer,
                    "level": level,
                    "route": route,
                    "route_reason": reason,
                    "metrics": service._metrics_from(m, led),
                    "flags": flags,
                    "llm": "llm",
                    "tools": result.get("tools_used", []),
                    "agent_steps": result.get("steps", []),
                    "actions": [
                        {"tab": "holdings"} if "market" in routes else None,
                        {"tab": "ledger"} if "ledger" in routes else None,
                    ],
                }
            }
        except agent.AgentUnavailable:
            log.warning("agent 工具循环不可用，图内降级确定性成文")
            has_data = True

    # 确定性模式：模板/模型润色成文（流式 text 事件，与旧流程一致）
    level = "L2 建议" if flags else "L1 洞察"
    # 体检意图：确定性输出五维报告（无模型也能「帮我体检」，数字仍来自本地内核）。
    # 空库同样走记账引导，不给「60 分」假象（与 template_answer 的空库保护一致）。
    wants_health = any(w in q for w in analysis.HEALTH_WORDS)
    if wants_health and has_data:
        fallback = analysis.health_report_text(
            analysis.health_check(market, ledger, flags, await db.list_goals(), lang=state.get("lang", "zh")),
            state.get("lang", "zh"),
        )
    elif wants_health:
        fallback = analysis.no_data_answer(state.get("lang", "zh"))
    else:
        fallback = analysis.template_answer(market, ledger, flags, has_data=has_data)
    history = await service._build_history(tid)
    system = (
        "你是用户的个人理财助手。根据给定的持仓与账本数据，用简洁的中文回答用户的问题："
        "先一句话给结论，再分点列出关键数字，最后提示风险项（如有）。"
        "不要编造任何未给出的数字，不要给出具体买卖指令。"
    )
    if state.get("lang") == "en":
        system = (
            "You are the user's personal finance assistant. Based on the holdings and ledger data provided, "
            "answer the user's question concisely in English: give a one-line conclusion first, "
            "then list key numbers point by point, and finally note any risks (if any). "
            "Never invent numbers not provided, and never give specific buy/sell instructions."
        )
    if history:
        system += (
            "本次附带了同一会话的历史问答，用于理解「那上个月呢」这类省略追问："
            "历史只作上下文参考，所有数字必须以本轮给定数据为准，不得沿用历史里的数字。"
        )
    user_obj: dict[str, Any] = {
        "question": q,
        "market": market,
        "ledger": ledger,
        "flags": flags,
        "level": level,
    }
    if history:
        user_obj["history"] = history
    user = json.dumps(user_obj, ensure_ascii=False)

    await _emit({"type": "step", "id": "finalize", "label": "整理成文", "detail": "汇总结论与数字", "phase": "start"})

    chunks: list[str] = []
    src = "template"
    async for delta, s in llm.stream_narrate(system, user, fallback):
        src = s
        chunks.append(delta)
        await _emit({"type": "text", "delta": delta})

    answer = "".join(chunks).strip() or fallback
    if analysis.DISCLAIMER not in answer:
        answer = answer + "\n\n— " + analysis.DISCLAIMER

    await _emit({"type": "step", "id": "finalize", "label": "整理成文", "detail": "已完成", "phase": "done"})

    return {
        "result": {
            "answer": answer,
            "level": level,
            "route": route,
            "route_reason": reason,
            "metrics": service._metrics_from(market, ledger),
            "flags": flags,
            "llm": src,
            "tools": [],
            "actions": [
                {"tab": "holdings"} if "market" in routes else None,
                {"tab": "ledger"} if "ledger" in routes else None,
            ],
        }
    }


# ---------------------------------------------------------------------------
# 图构建
# ---------------------------------------------------------------------------


def _supervisor_route(state: AgentState) -> str:
    r = state.get("route") or ""
    if r == "bookkeeping":
        return "record"
    if r == "memory":
        return "memory"
    if r == "action":
        return "action"
    if r == "general":
        return "general"
    return "finance"


def _build_graph() -> Any:
    g = StateGraph(AgentState)
    g.add_node("supervisor", supervisor)
    g.add_node("record", record)
    g.add_node("memory", memory)
    g.add_node("action", action)
    g.add_node("general", general)
    g.add_node("collect_market", collect_market)
    g.add_node("collect_ledger", collect_ledger)
    g.add_node("risk", risk)
    g.add_node("finalize", finalize)

    g.add_edge(START, "supervisor")
    g.add_conditional_edges(
        "supervisor",
        _supervisor_route,
        {"record": "record", "memory": "memory", "general": "general", "action": "action", "finance": "collect_market"},
    )
    # 多智能体管线：市场 agent → 账本 agent → 风控 agent → 成文 agent
    # （顺序边：单连接 aiosqlite 不支持跨节点并发读写，结构并行、执行串行）
    g.add_edge("collect_market", "collect_ledger")
    g.add_edge("collect_ledger", "risk")
    g.add_edge("risk", "finalize")
    g.add_edge("record", END)
    g.add_edge("memory", END)
    g.add_edge("action", END)
    g.add_edge("general", END)
    g.add_edge("finalize", END)
    return g.compile()


_graph: Any | None = None


def get_graph() -> Any:
    global _graph
    if _graph is None:
        _graph = _build_graph()
    return _graph


async def run_graph(question: str, emit: Emit, thread_id: str | None = None, lang: str = "zh") -> dict[str, Any]:
    """跑一轮图，返回最终 result（供 service.run_question 使用）。

    图失败（节点异常/模型调用异常等）抛异常，由调用方降级旧确定性路径。
    lang：界面语言（zh/en），确定性兜底文案与 agent 语言指令跟随。
    """
    token = _emit_ctx.set(emit)
    try:
        state: AgentState = {"question": question, "thread_id": thread_id, "lang": lang}
        out = await get_graph().ainvoke(state)
        result = out.get("result")
        if not isinstance(result, dict) or "answer" not in result:
            raise RuntimeError("图执行未产出 result")
        return result
    finally:
        _emit_ctx.reset(token)
