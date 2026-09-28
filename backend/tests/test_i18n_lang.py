"""界面语言 i18n：回答与确定性兜底文案跟随 lang（zh/en）。

覆盖：
- analysis：no_data_answer / health_report_text 双语
- service：_try_nl_add 回执 / _run_general 兜底 双语
- 图：run_graph lang 贯穿（AgentState.lang 字段，LangGraph 不会丢弃）
"""

from __future__ import annotations

from typing import Any

from app import analysis, service


async def _collect(run: Any, question: str, thread_id: str | None = None, lang: str = "zh") -> tuple[list[dict], dict]:
    events: list[dict[str, Any]] = []

    async def emit(ev: dict[str, Any]) -> None:
        events.append(ev)

    result = await run(question, emit, thread_id, lang=lang)
    return events, result


# ---------------------------------------------------------------------------
# analysis 模板
# ---------------------------------------------------------------------------


def test_no_data_answer_bilingual() -> None:
    zh = analysis.no_data_answer("zh")
    en = analysis.no_data_answer("en")
    assert "记一笔" in zh and "还没有录入任何数据" in zh
    assert "Record a transaction" in en and "haven't recorded any data" in en


def test_health_report_text_bilingual() -> None:
    report: dict[str, Any] = {
        "score": 40,
        "summary": "有几项需要关注，按建议逐条处理即可",
        "dimensions": [
            {"key": "portfolio", "title": "资产配置", "status": "warn", "detail": "存在 1 项集中度超限", "suggestion": "考虑分散配置"},
        ],
        "flags": [],
    }
    zh = analysis.health_report_text(report, "zh")
    en = analysis.health_report_text(report, "en")
    assert "财务体检综合评分 40 分" in zh and "资产配置（需关注）" in zh
    assert "Financial health score: 40" in en and "Asset mix (Attention)" in en
    assert "Suggestion:" in en


# ---------------------------------------------------------------------------
# service 确定性兜底
# ---------------------------------------------------------------------------


async def test_run_general_fallback_lang(temp_db, monkeypatch) -> None:
    """通用问题 + lang=en：未接模型时兜底文案为英文。"""
    async def _no_llm() -> bool:
        return False
    monkeypatch.setattr(service.llm, "llm_available", _no_llm)
    _, result = await _collect(service.run_question, "帮我写一段感谢信", lang="en")
    assert "No model is connected" in result["answer"]
    assert result["route"] == "general"


async def test_nl_add_receipt_bilingual(temp_db, monkeypatch) -> None:
    """一句话记账回执跟随 lang（en 时英文回执，仍入账）。"""
    async def _no_llm() -> bool:
        return False
    monkeypatch.setattr(service.llm, "llm_available", _no_llm)
    _, zh = await _collect(service.run_question, "昨天打车 32 元", thread_id="t-zh", lang="zh")
    assert "已记一笔" in zh["answer"]
    _, en = await _collect(service.run_question, "昨天打车 32 元", thread_id="t-en", lang="en")
    assert "Recorded:" in en["answer"] and "CNY" in en["answer"]


# ---------------------------------------------------------------------------
# 图 lang 贯穿（LangGraph state 不丢字段）
# ---------------------------------------------------------------------------


async def test_graph_lang_reaches_finalize(temp_db, monkeypatch) -> None:
    """体检 + lang=en：确定性体检报告为英文壳（回归 AgentState.lang 丢弃缺陷）。"""
    async def _no_llm() -> bool:
        return False
    monkeypatch.setattr(service.llm, "llm_available", _no_llm)
    _, result = await _collect(service.run_question, "帮我体检一下财务状况", lang="en")
    assert "Financial health score" in result["answer"]
    _, zh = await _collect(service.run_question, "帮我体检一下财务状况", lang="zh")
    assert "财务体检综合评分" in zh["answer"]
