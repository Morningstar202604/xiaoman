"""Agent 工具调用层单测：工具执行、工具循环、降级路径。

不触网：httpx.MockTransport 假冒 OpenAI 兼容端点（含 function calling 回包）。
"""

from __future__ import annotations

import json

import httpx
import pytest
from app import agent, db, llm, tools


def _chat_resp(content: str | None = None, tool_calls: list[dict] | None = None) -> httpx.Response:
    msg: dict = {"role": "assistant"}
    if content is not None:
        msg["content"] = content
    if tool_calls:
        msg["tool_calls"] = tool_calls
    return httpx.Response(200, json={"choices": [{"message": msg, "finish_reason": "stop"}]})


def _tc(name: str, arguments: dict, call_id: str = "call_1") -> dict:
    return {
        "id": call_id,
        "type": "function",
        "function": {"name": name, "arguments": json.dumps(arguments, ensure_ascii=False)},
    }


def _inject(monkeypatch, handler) -> None:
    monkeypatch.setattr(
        llm,
        "_client_kwargs",
        {"http_client": httpx.AsyncClient(transport=httpx.MockTransport(handler))},
    )


@pytest.fixture(autouse=True)
def _reset(monkeypatch):
    llm.invalidate()
    monkeypatch.setattr(llm, "_client_kwargs", None)
    monkeypatch.setattr(llm, "_cfg", None)
    yield
    llm.invalidate()


# ---------------------------------------------------------------------------
# 工具执行体
# ---------------------------------------------------------------------------


async def test_tool_market_view_with_empty_positions(temp_db):
    # init_db 会播种示例数据；先清空持仓模拟"还没有持仓"
    await db.fetch_all("DELETE FROM positions")
    out = json.loads(await tools.tool_get_market_view({}))
    assert out["empty"] is True


async def test_tool_record_transaction_parses(temp_db):
    out = json.loads(await tools.tool_record_transaction({"text": "昨天打车 32 元"}))
    assert out["ok"] is True
    assert out["amount"] == -32
    rows = await db.list_transactions()
    assert any(r["item"] == "打车" for r in rows)


async def test_tool_budget_shape(temp_db):
    out = json.loads(await tools.tool_get_budget({}))
    assert "month" in out and "budgets" in out


async def test_tool_kline_falls_back(temp_db, monkeypatch):
    async def _fake(symbol, period, limit):
        return {
            "symbol": symbol,
            "period": period,
            "source": "fake",
            "points": [{"date": "2026-09-01", "close": 10.0, "pct_change": 0.1}],
        }

    # tools.py 在模块加载时绑定 fetch_kline，须直接 patch tools 模块
    monkeypatch.setattr(tools, "fetch_kline", _fake)
    out = json.loads(await tools.tool_get_kline({"symbol": "600519"}))
    assert out["symbol"] == "600519" and out["points"]


async def test_truncate_tool_result():
    long = "x" * 5000
    out = tools.truncate_tool_result(long)
    assert len(out) <= tools.TOOL_RESULT_MAX_CHARS + 20


# ---------------------------------------------------------------------------
# 工具循环编排
# ---------------------------------------------------------------------------


async def test_agent_calls_tool_then_answers(temp_db, monkeypatch):
    """模型先要求查持仓 → 工具结果回填 → 模型成文。"""
    calls: list[dict] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        calls.append(body)
        if not body.get("tools"):
            raise AssertionError("请求必须带 tools 定义")
        n_tool_msgs = sum(1 for m in body["messages"] if m["role"] == "tool")
        if n_tool_msgs == 0:
            return _chat_resp(tool_calls=[_tc("get_market_view", {})])
        return _chat_resp(content="你的持仓总市值 X 元。")

    _inject(monkeypatch, handler)
    llm._cfg = {"base": "http://mock.invalid/v1", "key": "sk-test", "model": "m"}

    events: list[dict] = []

    async def emit(e: dict) -> None:
        events.append(e)

    result = await agent.run_agent("我的持仓怎么样", emit)
    assert result["answer"] == "你的持仓总市值 X 元。"
    assert result["tools_used"] == ["get_market_view"]
    # 工具结果确实回填给了模型（messages 里出现 role=tool 且内容非空）
    last = calls[-1]
    tool_msgs = [m for m in last["messages"] if m["role"] == "tool"]
    assert tool_msgs and json.loads(tool_msgs[0]["content"])["total_market_value"] >= 0
    # 过程事件：agent_step 已发出
    assert any(e["type"] == "agent_step" and e["name"] == "get_market_view" for e in events)


async def test_agent_direct_answer_no_tools(temp_db, monkeypatch):
    async def handler(request: httpx.Request) -> httpx.Response:
        return _chat_resp(content="这是闲聊，不需要工具。")

    _inject(monkeypatch, handler)
    llm._cfg = {"base": "http://mock.invalid/v1", "key": "sk-test", "model": "m"}
    result = await agent.run_agent("你好", lambda e: _noop())
    assert result["answer"] == "这是闲聊，不需要工具。"
    assert result["tools_used"] == []


async def _noop() -> None:
    return None


async def test_agent_unavailable_without_config(temp_db):
    llm._cfg = {}
    with pytest.raises(agent.AgentUnavailable):
        await agent.run_agent("我的持仓怎么样", lambda e: _noop())


async def test_agent_unavailable_on_http_error(temp_db, monkeypatch):
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"error": {"message": "boom"}})

    _inject(monkeypatch, handler)
    llm._cfg = {"base": "http://mock.invalid/v1", "key": "sk-test", "model": "m"}
    with pytest.raises(agent.AgentUnavailable):
        await agent.run_agent("我的持仓怎么样", lambda e: _noop())


async def test_agent_loop_cap(temp_db, monkeypatch):
    """模型每次都要求调工具 → 超过轮数上限抛 AgentUnavailable（防死循环）。"""
    n = {"turns": 0}

    async def handler(request: httpx.Request) -> httpx.Response:
        n["turns"] += 1
        return _chat_resp(tool_calls=[_tc("get_market_view", {})])

    _inject(monkeypatch, handler)
    llm._cfg = {"base": "http://mock.invalid/v1", "key": "sk-test", "model": "m"}
    with pytest.raises(agent.AgentUnavailable):
        await agent.run_agent("我的持仓怎么样", lambda e: _noop())
    assert n["turns"] <= agent.MAX_TURNS + 1


async def test_agent_survives_unknown_tool(temp_db, monkeypatch):
    """模型调用未知工具 → 回填错误而非崩溃。"""
    async def handler(request: httpx.Request) -> httpx.Response:
        return _chat_resp(tool_calls=[_tc("not_a_real_tool", {})])

    _inject(monkeypatch, handler)
    llm._cfg = {"base": "http://mock.invalid/v1", "key": "sk-test", "model": "m"}
    # 未知工具回填后模型未继续产出 → 本轮无内容 → AgentUnavailable（不崩溃即达标）
    with pytest.raises(agent.AgentUnavailable):
        await agent.run_agent("查一下", lambda e: _noop())


async def test_agent_memory_preinjected(temp_db, monkeypatch):
    """用户长期记忆预注入 system 消息：模型无需先调工具即可参考用户背景。"""
    await db.add_memory("明年计划买房，首付预算 30 万")
    captured: list[dict] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        captured.append(body)
        return _chat_resp(content="了解，按你的买房计划看…")

    _inject(monkeypatch, handler)
    llm._cfg = {"base": "http://mock.invalid/v1", "key": "sk-test", "model": "m"}
    result = await agent.run_agent("我该怎么为买房准备", lambda e: _noop())
    assert result["answer"] == "了解，按你的买房计划看…"
    sys_msgs = captured[0]["messages"]
    mem_sys = [m for m in sys_msgs if m["role"] == "system" and "明年计划买房" in m["content"]]
    assert mem_sys, "长期记忆应预注入 system 消息"


# ---------------------------------------------------------------------------
# 买入动作（run_action）：行情不可达降级提示补成本；行情可达按现价建仓
# ---------------------------------------------------------------------------


async def test_buy_without_quote_asks_for_cost(temp_db, monkeypatch):
    """行情源不可达时「买入 600519 100 股」应提示补成本，而不是报错。"""
    async def no_quote(_sym: str) -> dict | None:
        return None

    monkeypatch.setattr(tools, "quote_now", no_quote)
    before = {p["symbol"]: p["shares"] for p in await db.list_positions()}
    out = await tools.run_action("买入 600519 100 股")
    assert out["route"] == "action"
    assert out["level"] == "需要补充"
    assert "成本" in out["answer"]
    # 持仓未被误改（seed 里 600519 的份额保持不变）
    after = {p["symbol"]: p["shares"] for p in await db.list_positions()}
    assert after.get("600519") == before.get("600519")


async def test_buy_with_quote_records_position(temp_db, monkeypatch):
    """行情可达时「买入 600519 100 股」按现价建仓。"""
    async def with_quote(_sym: str) -> dict:
        return {"price": 1250.0, "name": "贵州茅台", "symbol": "600519"}

    monkeypatch.setattr(tools, "quote_now", with_quote)
    out = await tools.run_action("买入 600519 100 股")
    assert out["route"] == "action"
    assert out["level"] == "已执行"
    assert "600519" in out["answer"]
    pos = await db.list_positions()
    mine = [p for p in pos if p["symbol"] == "600519"]
    assert len(mine) == 1
    assert mine[0]["shares"] == 100
    assert mine[0]["cost"] == 1250.0
