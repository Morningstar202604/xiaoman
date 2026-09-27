"""问答服务：把用户的提问跑成一份可复核的财务回答。

唯一执行路径是 LangGraph 多智能体编排图（app/agent_graph.py）：
  supervisor（分类 agent）→ 记账 / 通用 / 市场+账本+风控 / 成文 agent 节点，
  图负责编排与状态流转，数字仍由 analysis 确定性内核计算；
  成文节点内捕获 agent 工具循环失败并降级确定性模板（图内降级，无旧双轨）。
  本模块只保留图各节点复用的纯函数（路由/历史/通用/记账解析/指标）。

事件契约（SSE，由 main.py 转发给前端）：
  {"type":"start","question":...}
  {"type":"step","id":"market","label":"查看持仓","detail":"...","phase":"start|done"}
  {"type":"agent_step","name":"get_market_view","args":{...},"summary":"..."}  # agent 模式
  {"type":"text","delta":"..."}          # 成文增量（LLM 流式 或 模板一次给出）
  {"type":"final","answer":...,"level":...,"route":...,"metrics":{...},"flags":[...],"llm":"llm|template"}
"""

from __future__ import annotations

import json
import re
from collections.abc import Awaitable, Callable
from typing import Any

from . import db, llm, nlparse

Emit = Callable[[dict[str, Any]], Awaitable[None]]

MARKET_WORDS = ("股票", "基金", "持仓", "仓位", "组合", "收益", "亏", "涨", "跌", "etf", "市值", "资产", "集中度", "配置")
LEDGER_WORDS = ("花", "支出", "记账", "账", "预算", "订阅", "会员", "还款", "负债", "房贷", "信用卡", "现金流", "存", "省", "应急金", "储蓄", "收入", "余额", "工资")
# 目标/体检专用词：命中即按「市场+账本」全量财务路由（体检与目标进度需要完整数据）。
# 刻意不用「目标」「进度」这类宽泛词，避免「人生目标」这类非财务问法被误伤（宁缺毋滥）。
GOAL_WORDS = ("体检", "健康检查", "存够", "攒够", "首付", "买房", "买车", "还差多少", "建议月存", "攒钱", "存款目标", "攒首付")
# 记忆动词：短句 + 无问号 → 对话内「记住/记得 …」直接存长期记忆（规则级，无需模型）
MEMORY_VERBS = ("记住", "记得")

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

# 多轮上下文：最多回看 4 轮，每条截断 400 字（控制 token 与外发体量）
HISTORY_TURNS = 4
HISTORY_ANSWER_CHARS = 400

# 省略式追问：短句 + 指代词（「那上个月呢？」本身不含财务关键词，需承接上一轮）
FOLLOWUP_MARKS = ("那", "它", "这个", "上个月", "上月", "刚才", "刚刚", "其中", "前面")
FOLLOWUP_MAX_LEN = 12


def _has_finance_word(text: str) -> bool:
    q = text.lower()
    return any(w in q for w in MARKET_WORDS) or any(w in q for w in LEDGER_WORDS)


async def _is_finance_followup(question: str, thread_id: str | None) -> bool:
    """判断是否为承接上一轮财务提问的省略追问。

    四重约束同时成立才改判为财务路由：短句、含指代词、本会话上一轮是财务提问、已接入模型。
    未接入模型时不改判——确定性内核只算「本月」，让它回答「上个月」是误导。
    """
    q = question.strip()
    if not thread_id or len(q) > FOLLOWUP_MAX_LEN:
        return False
    if not any(m in q for m in FOLLOWUP_MARKS):
        return False
    if not await llm.llm_available():
        return False
    runs = await db.list_runs(thread_id, 1)
    return bool(runs) and _has_finance_word(str(runs[0].get("question") or ""))


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
    """规则分类（不调模型）：命中目标/体检词 → goal（全量财务路由），命中投资词 → market，
    命中收支词 → ledger，都命中 → both，都不命中 → general。

    宁缺毋滥：不确定是否问财务时一律 general，绝不做「猜测式财务综合分析」。
    """
    q = question.lower()
    hit_g = [w for w in GOAL_WORDS if w in q]
    if hit_g:
        return "goal", f"涉及财务目标/体检（{hit_g[0]}）"
    hit_m = [w for w in MARKET_WORDS if w in q]
    hit_l = [w for w in LEDGER_WORDS if w in q]
    if hit_m and hit_l:
        return "both", f"同时涉及持仓({hit_m[0]})与收支({hit_l[0]})"
    if hit_m:
        return "market", f"涉及持仓/行情（{hit_m[0]}）"
    if hit_l:
        return "ledger", f"涉及收支/负债（{hit_l[0]}）"
    return "general", "未命中财务关键词，按通用问答处理"


def _looks_like_memory(question: str) -> bool:
    """短句 + 记忆动词 + 无疑问词 → 视为「记住/记得 …」记忆指令。

    与一句话记账同一套保守判定：疑问句（「你还记得吗」）绝不当记忆指令。
    """
    q = question.strip()
    if not q or len(q) > NL_MAX_LEN:
        return False
    if any(m in q for m in QUESTION_MARKS):
        return False
    return any(v in q for v in MEMORY_VERBS)


async def _try_save_memory(question: str, emit: Emit) -> dict[str, Any] | None:
    """对话内记忆指令：规则提取内容 → 存长期记忆 → 回执（无需模型）。

    提取「记住/记得」之后的内容；提取不到有效内容（如单独一个「记住」）返回 None。
    """
    if not _looks_like_memory(question):
        return None
    content = re.sub(
        rf"^(?:帮我|请|麻烦|要|我想)*?(?:{'|'.join(MEMORY_VERBS)})[:：]?",
        "",
        question.strip(),
    ).strip("，。！、 ")
    if len(content) < 2:
        return None

    out = await db.add_memory(content)
    await emit({
        "type": "step", "id": "memory", "label": "已记住",
        "detail": content[:30] + ("…" if len(content) > 30 else ""), "phase": "done",
    })
    return {
        "answer": (
            f"好，我记住了：{content}。\n\n"
            "以后涉及相关问题时我会参考它；可在「设置 → 长期记忆」查看或删除。"
        ),
        "level": "已记住",
        "route": "memory",
        "route_reason": "识别为「记住/记得 …」记忆指令，直接存长期记忆",
        "metrics": {},
        "flags": [],
        "llm": "template",
        "memory_deduped": out.get("deduped", False),
    }


async def _build_history(
    thread_id: str | None, only_route: str | None = None
) -> list[dict[str, str]]:
    """取本会话最近若干轮问答（时间正序），让助手记得上文。

    only_route="general" 时只取同为通用的轮次：通用 agent 也有对话记忆，
    但财务轮次的内容绝不出机（隐私边界，见 test_general_chat_never_carries_finance_history）。
    未接入模型时直接返回空，避免无意义的 DB 查询。
    """
    if not thread_id or not await llm.llm_available():
        return []
    runs = await db.list_runs(thread_id, HISTORY_TURNS)
    if only_route:
        runs = [r for r in runs if (r.get("route") or "") == only_route]
    out: list[dict[str, str]] = []
    for r in reversed(runs):  # list_runs 是倒序（最新在前），翻成时间正序
        q = str(r.get("question") or "").strip()
        a = str(r.get("answer") or "").strip()
        if q:
            out.append({"role": "user", "content": q[:HISTORY_ANSWER_CHARS]})
        if a:
            out.append({"role": "assistant", "content": a[:HISTORY_ANSWER_CHARS]})
    return out


async def _run_general(question: str, reason: str, emit: Emit, thread_id: str | None = None) -> dict[str, Any]:
    """默认路径：通用 agent。

    - 带同会话的通用上下文（它得记得上文，否则不叫 agent）
    - 不注入也不外发任何财务数据；财务轮次的历史同样不出机
    - 不套财务分级（level 留空）、不拼财务免责声明、不发内部步骤（工程细节不进界面）
    """
    history = await _build_history(thread_id, only_route="general")
    user_obj: dict[str, Any] = {"question": question}
    if history:
        user_obj["history"] = history
    user = json.dumps(user_obj, ensure_ascii=False)

    chunks: list[str] = []
    src = "template"
    async for delta, s in llm.stream_narrate(GENERAL_SYSTEM, user, GENERAL_FALLBACK):
        src = s
        chunks.append(delta)
        await emit({"type": "text", "delta": delta})

    return {
        "answer": "".join(chunks).strip() or GENERAL_FALLBACK,
        "level": "",
        "route": "general",
        "route_reason": reason,
        "metrics": {},
        "flags": [],
        "llm": src,
    }


def _metrics_from(
    market: dict[str, Any] | None, ledger: dict[str, Any] | None
) -> dict[str, float]:
    metrics: dict[str, float] = {}
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
    return metrics


async def run_question(question: str, emit: Emit, thread_id: str | None = None) -> dict[str, Any]:
    """执行一轮问答，返回最终元信息（由调用方负责归档与转发 final 事件）。

    主路径：LangGraph 多智能体图（agent_graph.run_graph）。
    图任何一步失败（节点异常/模型调用异常等）→ 降级本模块旧顺序流程（_legacy），
    保证与图同构的输出与事件，服务不中断、不冒充模型结果。
    """
    await emit({"type": "start", "question": question})
    from .agent_graph import run_graph

    return await run_graph(question, emit, thread_id)
