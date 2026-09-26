"""模型接入层单测：配置解析、流式/非流式调用、SDK 重试与模板兜底。

不触网：用 httpx.MockTransport 假冒 OpenAI 兼容端点。
"""

from __future__ import annotations

import json

import httpx
import pytest
from app import llm

SSE_HEAD = {"content-type": "text/event-stream"}


def _sse(*deltas: str) -> bytes:
    body = "".join(
        f"data: {json.dumps({'choices': [{'delta': {'content': d}}]})}\n\n" for d in deltas
    )
    body += "data: [DONE]\n\n"
    return body.encode()


def _inject(monkeypatch, handler) -> None:
    monkeypatch.setattr(
        llm, "_client_kwargs", {"http_client": httpx.AsyncClient(transport=httpx.MockTransport(handler))}
    )


@pytest.fixture(autouse=True)
def _reset(monkeypatch):
    llm.invalidate()
    monkeypatch.setattr(llm, "_client_kwargs", None)
    yield
    llm.invalidate()


async def test_no_config_yields_template() -> None:
    """未配置模型 → 只产出一段模板，且来源标 template。"""
    llm._cfg = {}
    out = [x async for x in llm.stream_narrate("sys", "user", "模板答案")]
    assert out == [("模板答案", "template")]


async def test_stream_reads_sse_deltas(monkeypatch) -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer sk-test"
        assert json.loads(request.content)["stream"] is True
        return httpx.Response(200, headers=SSE_HEAD, content=_sse("你", "好"))

    _inject(monkeypatch, handler)
    llm._cfg = {"base": "http://mock.invalid/v1", "key": "sk-test", "model": "m"}
    out = [x async for x in llm.stream_narrate("sys", "user", "模板")]
    assert out == [("你", "llm"), ("好", "llm")]


async def test_stream_retries_then_succeeds(monkeypatch) -> None:
    """第一次 500 → SDK 自动重试 → 拿到增量，而不是整体降级成模板。"""
    calls = {"n": 0}

    async def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(500, json={"error": {"message": "boom"}})
        return httpx.Response(200, headers=SSE_HEAD, content=_sse("成功"))

    _inject(monkeypatch, handler)
    llm._cfg = {"base": "http://mock.invalid/v1", "key": "sk-test", "model": "m"}
    out = [x async for x in llm.stream_narrate("sys", "user", "模板")]
    assert calls["n"] == 2, "SDK 应自动重试一次"
    assert out == [("成功", "llm")]


async def test_stream_all_fail_yields_template(monkeypatch) -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"error": {"message": "boom"}})

    _inject(monkeypatch, handler)
    llm._cfg = {"base": "http://mock.invalid/v1", "key": "sk-test", "model": "m"}
    out = [x async for x in llm.stream_narrate("sys", "user", "模板答案")]
    assert out == [("模板答案", "template")]


async def test_json_complete_parses_object(monkeypatch) -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        assert json.loads(request.content)["stream"] is False
        return httpx.Response(200, json={"choices": [{"message": {"content": '前缀 {"a": 1} 后缀'}}]})

    _inject(monkeypatch, handler)
    llm._cfg = {"base": "http://mock.invalid/v1", "key": "sk-test", "model": "m"}
    assert await llm.json_complete("sys", "user") == {"a": 1}


async def test_json_complete_invalid_json_returns_none(monkeypatch) -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"choices": [{"message": {"content": "not json"}}]})

    _inject(monkeypatch, handler)
    llm._cfg = {"base": "http://mock.invalid/v1", "key": "sk-test", "model": "m"}
    assert await llm.json_complete("sys", "user") is None
