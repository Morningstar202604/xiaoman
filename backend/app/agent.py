"""Agent 编排层：LLM function calling 多轮工具循环（真正的垂直 agent）。

与 agent_graph.py 的分工：
  - agent_graph.py 负责「编排」：意图分类、节点顺序、条件分支（LangGraph 状态机）；
  - 本模块负责「成文执行」：finalize 节点在 agent 模式下调用本模块的 run_agent，
    让模型自主决定调用 tools.py 里的工具取数并成文；
  - 模型不可用/工具循环失败 → 抛 AgentUnavailable，由 agent_graph.finalize 图内降级
    确定性模板成文（不是双实现，是编排层与执行层的分工）。

流程：
  财务问题 + 已接入模型 → 交给模型自主决定调用哪些工具（查持仓/账本/风控/记账/预算/趋势/K线/行情/自选/持仓录入），
  工具结果回填后由模型成文。最多 MAX_TURNS 轮工具循环。

事件契约（新增）：
  {"type":"agent_step","name":"get_market_view","args":{...},"summary":"总市值 282,540 元…"}

隐私边界与确定性内核保持一致：
  - 工具只读本地数据，结果摘要化后回填（truncate_tool_result）
  - 通用闲聊不带任何财务数据出机（路由仍由 service 层决定）
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from typing import Any

from . import db, llm, tools

# 写类工具已被确定性分支覆盖（记账/记忆/买卖/设置/备份/晨报都有前置 action/record/memory
# 节点拦截），agent 模式只暴露读类 + 自选维护工具，防止模型在追问/分析语境里越权落库。
WRITE_EXCLUDED = {
    "record_transaction", "save_user_memory", "record_position", "sell_position",
    "set_setting", "backup_now", "trigger_morning_report",
}
READ_TOOLS = [t for t in tools.TOOLS if t["function"]["name"] not in WRITE_EXCLUDED]

Emit = Callable[[dict[str, Any]], Awaitable[None]]

MAX_TURNS = 5

AGENT_SYSTEM = (
    "你是小满的财务助手。小满是一款个人理财 agent：管理记账、持仓、财务目标与长期记忆。"
    "你可以调用工具查询用户的真实数据（持仓、账本、风控、预算、趋势、K线、行情、自选、"
    "财务目标、长期记忆）或执行一句话记账/记录持仓/管理自选。规则：\n"
    "1. 需要数字时必须调用工具获取，绝不编造；\n"
    "2. 一次可并行调用多个不依赖的工具（如同时查持仓和账本）；\n"
    "3. 回答先给一句话结论，再分点列出关键数字，最后（如有）列出风险项；\n"
    "4. 不给具体买卖指令；\n"
    "5. 用户主动透露可用于未来的长期信息（家庭、职业、计划、偏好）时调用 save_user_memory 记住，"
    "并告知已记住；回答涉及用户背景时先查 get_user_memory；\n"
    "6. 用户要求体检/评估整体财务状况时调用 get_health_check；问目标进展用 get_goals；\n"
    "7. 工具结果为空/不可用时如实说明，不猜测；\n"
    "8. 用户想了解或关注某只标的（股票/基金/指数）时，按需把流程串起来一步做完："
    "search_symbol 找到代码 → get_quote 看实时行情 → get_kline 看走势 → "
    "用户说「关注/盯/加自选」就 add_to_watchlist，最后用一句话汇报各步骤结果；\n"
    "9. 用户表达真实的持仓动作时调用工具落库：买入（如「买了 100 股茅台成本 1500」）→ "
    "record_position；日常花销/收入（如「咖啡 28」「工资到账」）→ record_transaction；"
    "并明确告知「已记录，可在总览/持仓/记账页查看」；\n"
    "10. 行情、自选、持仓相关的任何数字（现价、涨跌、盈亏）都必须来自工具返回，绝不估算。"
)


class AgentUnavailable(Exception):
    """模型未配置或工具循环失败：调用方应降级到确定性路径。"""


def _tool_summary(name: str, result_text: str) -> str:
    """给前端的工具结果摘要（简短、可读）。"""
    try:
        data = json.loads(result_text)
    except Exception:  # noqa: BLE001
        return result_text[:80]
    if name == "get_market_view":
        if not isinstance(data, dict):
            return result_text[:80]
        return f"总市值 {data.get('total_market_value', 0):,} 元，累计盈亏 {data.get('total_pnl', 0):,} 元"
    if name == "get_ledger_view":
        if not isinstance(data, dict):
            return result_text[:80]
        return f"{data.get('month', '')} 收入 {data.get('income', 0):,}、支出 {data.get('expense', 0):,}、结余 {data.get('net', 0):,}"
    if name == "get_risk_flags":
        if not isinstance(data, dict):
            return result_text[:80]
        return f"发现 {data.get('count', 0)} 项需关注"
    if name == "get_budget":
        if not isinstance(data, dict):
            return result_text[:80]
        return f"{data.get('month', '')} 支出 {data.get('total_spent', 0):,} / 预算 {data.get('total_budget', 0):,}"
    if name == "get_trend":
        n = len(data) if isinstance(data, list) else 0
        return f"已取近 {n} 个月趋势"
    if name == "record_transaction":
        if not isinstance(data, dict):
            return result_text[:80]
        return f"已入账：{data.get('item', '')} {data.get('amount', 0):,} 元（{data.get('category', '')}）"
    if name == "get_kline":
        if not isinstance(data, dict):
            return result_text[:80]
        n = len(data.get("points", [])) if isinstance(data, dict) else 0
        return f"已取 {data.get('symbol', '')} {n} 个K线点"
    if name == "get_goals":
        if isinstance(data, dict) and data.get("empty"):
            return "暂无财务目标"
        if isinstance(data, list):
            parts = [f"{g.get('name', '')} {g.get('pct', 0)}%" for g in data[:3]]
            return "目标进度：" + "、".join(parts)
        return result_text[:80]
    if name == "get_user_memory":
        if isinstance(data, dict) and data.get("empty"):
            return "暂无长期记忆"
        if isinstance(data, list):
            return f"共 {len(data)} 条记忆"
        return result_text[:80]
    if name == "save_user_memory":
        return "已记住" if data.get("ok") else "记忆未保存"
    if name == "get_health_check":
        return f"体检综合评分 {data.get('score', 0)} 分，{data.get('summary', '')}"
    return result_text[:80]


async def run_agent(
    question: str,
    emit: Emit,
    history: list[dict[str, str]] | None = None,
    lang: str = "zh",
) -> dict[str, Any]:
    """跑一轮 agent：模型自主调用工具后成文。失败抛 AgentUnavailable。"""
    cfg = await llm._config()  # noqa: SLF001 — 同一包内复用配置读取
    if cfg is None:
        raise AgentUnavailable("未接入模型")

    client = llm._sdk(cfg, timeout=60.0, **(llm._client_kwargs or {}))  # noqa: SLF001
    lang_rule = "请用简体中文回答用户的问题。" if lang == "zh" else "Answer the user in English."
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": AGENT_SYSTEM},
        {"role": "system", "content": lang_rule},
    ]
    if history:
        messages.append(
            {
                "role": "system",
                "content": "同一会话历史（仅作上下文参考，数字一律以工具结果为准）："
                + json.dumps(history, ensure_ascii=False)[:2000],
            }
        )
    # 长期记忆预注入（用户主动要求记住的）：模型无需先调工具即可参考用户背景。
    # 只注入财务分支（run_agent 仅由 finalize 调用），通用 agent 分支不经过这里，隐私边界不变。
    memories = await db.list_memory()
    if memories:
        mem_text = "\n".join(f"- {m['content']}" for m in memories[:5])
        messages.append(
            {
                "role": "system",
                "content": "用户长期记忆（用户主动要求记住的，作上下文参考，需要精确数字仍以工具结果为准）：\n"
                + mem_text[:400],
            }
        )
    messages.append({"role": "user", "content": question})

    steps: list[dict[str, Any]] = []
    used_tools: list[str] = []
    tool_counts: dict[str, int] = {}

    for _turn in range(MAX_TURNS):
        try:
            resp = await client.chat.completions.create(
                model=cfg["model"],
                messages=messages,
                tools=READ_TOOLS,
                tool_choice="auto",
                temperature=0.2,
            )
        except Exception as exc:  # noqa: BLE001 — 端点失败/不支持 tools → 降级
            raise AgentUnavailable(f"模型调用失败：{type(exc).__name__}") from exc

        msg = resp.choices[0].message
        tool_calls = getattr(msg, "tool_calls", None)

        if not tool_calls:
            content = (msg.content or "").strip()
            if not content:
                raise AgentUnavailable("模型未产出回答")
            return {
                "answer": content,
                "steps": steps,
                "tools_used": used_tools,
                "tool_counts": tool_counts,
                "llm": "llm",
            }

        # 模型要求调用工具：先原样回填 assistant 消息，再执行工具并回填结果
        messages.append(
            {
                "role": "assistant",
                "content": msg.content or "",
                "tool_calls": [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {"name": tc.function.name, "arguments": tc.function.arguments},
                    }
                    for tc in tool_calls
                ],
            }
        )
        for tc in tool_calls:
            name = tc.function.name
            impl = tools.TOOL_IMPL.get(name)
            if impl is None:
                messages.append(
                    {"role": "tool", "tool_call_id": tc.id, "content": f"未知工具：{name}"}
                )
                continue
            try:
                args = json.loads(tc.function.arguments or "{}")
                if not isinstance(args, dict):
                    args = {}
            except json.JSONDecodeError:
                args = {}
            tool_counts[name] = tool_counts.get(name, 0) + 1
            used_tools.append(name)
            try:
                result = tools.truncate_tool_result(await impl(args))
            except Exception as exc:  # noqa: BLE001 — 工具失败回填错误，不让循环崩
                result = f"工具执行失败：{type(exc).__name__}: {exc}"
            messages.append({"role": "tool", "tool_call_id": tc.id, "content": result})
            summary = _tool_summary(name, result)
            steps.append({"name": name, "args": args, "summary": summary})
            await emit({"type": "agent_step", "name": name, "args": args, "summary": summary})

    raise AgentUnavailable(f"工具循环超过 {MAX_TURNS} 轮未收敛")
