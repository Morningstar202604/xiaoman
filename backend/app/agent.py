"""Agent 编排层：LLM function calling 多轮工具循环（真正的垂直 agent）。

流程：
  财务问题 + 已接入模型 → 交给模型自主决定调用哪些工具（查持仓/账本/风控/记账/预算/趋势/K线），
  工具结果回填后由模型成文。最多 MAX_TURNS 轮工具循环；任一步失败/未接入 → 抛 AgentUnavailable，
  由 service 层降级到确定性路径（数字仍然可靠，只是少了模型润色）。

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

Emit = Callable[[dict[str, Any]], Awaitable[None]]

MAX_TURNS = 5

AGENT_SYSTEM = (
    "你是随身理财的财务助手。你可以调用工具查询用户的真实数据（持仓、账本、风控、预算、趋势、K线、"
    "财务目标、长期记忆）或执行一句话记账/记一条长期记忆。规则：\n"
    "1. 需要数字时必须调用工具获取，绝不编造；\n"
    "2. 一次可并行调用多个不依赖的工具（如同时查持仓和账本）；\n"
    "3. 回答先给一句话结论，再分点列出关键数字，最后（如有）列出风险项；\n"
    "4. 不给具体买卖指令；记账指令调用 record_transaction，并告知已入账；\n"
    "5. 用户主动透露可用于未来的长期信息（家庭、职业、计划、偏好）时调用 save_user_memory 记住，"
    "并告知已记住；回答涉及用户背景时先查 get_user_memory；\n"
    "6. 用户要求体检/评估整体财务状况时调用 get_health_check；问目标进展用 get_goals；\n"
    "7. 工具结果为空/不可用时如实说明，不猜测。"
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
) -> dict[str, Any]:
    """跑一轮 agent：模型自主调用工具后成文。失败抛 AgentUnavailable。"""
    cfg = await llm._config()  # noqa: SLF001 — 同一包内复用配置读取
    if cfg is None:
        raise AgentUnavailable("未接入模型")

    client = llm._sdk(cfg, timeout=60.0, **(llm._client_kwargs or {}))  # noqa: SLF001
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": AGENT_SYSTEM},
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
                tools=tools.TOOLS,
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
