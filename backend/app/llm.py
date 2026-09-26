"""模型接入：官方 openai SDK（AsyncOpenAI）直连任何 OpenAI 兼容端点
（豆包 / DeepSeek / 通义千问 / Agnes 等）。

相比自研 httpx 调用，SDK 自带指数退避重试（429/5xx/超时，默认 2 次）、
统一错误类型与流式解析；未配置或全部失败时仍退回确定性模板，不冒充模型输出。

配置来源（优先级）：
1. 设置中心的「AI 回答」配置（ai_enabled=on 且 base/key/model 非空时生效）
2. 环境变量 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL
"""

from __future__ import annotations

import json
import os
import re
from collections.abc import AsyncIterator
from typing import Any

from dotenv import load_dotenv
from openai import AsyncOpenAI

load_dotenv()

# 重试：连接错误/超时/429/5xx 最多重试 2 次（SDK 默认值），退避由 SDK 处理
MAX_RETRIES = 2
STREAM_TIMEOUT = 60.0
JSON_TIMEOUT = 20.0

_client: AsyncOpenAI | None = None
_cfg: dict[str, str] | None = None
# 构造入参（测试注入 MockTransport 用；生产为 None）
_client_kwargs: dict[str, Any] | None = None


async def _config() -> dict[str, str] | None:
    global _cfg
    if _cfg is not None:
        return _cfg or None

    # 1) 设置中心（数据库）优先：ai_enabled=on 且三要素齐全
    try:
        from . import db

        s = await db.get_settings()
        base = (s.get("ai_base_url") or "").strip().rstrip("/")
        key = (s.get("ai_api_key") or "").strip()
        model = (s.get("ai_model") or "").strip()
        if s.get("ai_enabled") == "on" and base and key and model:
            _cfg = {"base": base, "key": key, "model": model}
            return _cfg
    except Exception:  # noqa: BLE001 — 读取失败不影响后续
        pass

    # 2) 环境变量兜底
    base = os.getenv("LLM_BASE_URL", "").strip().rstrip("/")
    key = os.getenv("LLM_API_KEY", "").strip()
    model = os.getenv("LLM_MODEL", "").strip()
    _cfg = {"base": base, "key": key, "model": model} if base and key and model else {}
    return _cfg or None


def invalidate() -> None:
    """设置中心修改 AI 配置后调用，使下次调用重新读取。"""
    global _cfg
    _cfg = None


async def llm_available() -> bool:
    return await _config() is not None


def _client_ref() -> AsyncOpenAI | None:
    """惰性构造 SDK 客户端；构造失败（缺 key 等）返回 None 由调用方降级。"""
    global _client
    if _client is None:
        try:
            _client = AsyncOpenAI(
                api_key=os.getenv("LLM_API_KEY", "") or "unset",
                base_url=os.getenv("LLM_BASE_URL", "") or None,
                max_retries=MAX_RETRIES,
                timeout=STREAM_TIMEOUT,
                **(_client_kwargs or {}),
            )
        except Exception:  # noqa: BLE001 — 客户端构造失败视为未接入
            return None
    return _client


def _sdk(cfg: dict[str, str], *, timeout: float, **kwargs: Any) -> AsyncOpenAI:
    """按当前配置构造一次性客户端（每次调用独立，避免配置切换后残留旧 client）。"""
    return AsyncOpenAI(
        api_key=cfg["key"],
        base_url=cfg["base"],
        max_retries=MAX_RETRIES,
        timeout=timeout,
        **kwargs,
    )


async def aclose() -> None:
    global _client
    if _client is not None:
        try:
            await _client.close()
        except Exception:  # noqa: BLE001 — 关闭失败不影响退出
            pass
    _client = None


async def stream_narrate(system: str, user: str, fallback: str) -> AsyncIterator[tuple[str, str]]:
    """流式调用；失败或空流时整体退回模板。

    产出 (文本增量, 来源)。来源一旦为 'llm'，后续增量保持 llm；模板只产出一次。
    """
    cfg = await _config()
    if cfg is None:
        yield fallback, "template"
        return
    got_any = False
    try:
        stream = await _sdk(cfg, timeout=STREAM_TIMEOUT, **(_client_kwargs or {})).chat.completions.create(
            model=cfg["model"],
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            temperature=0.2,
            stream=True,
        )
        async for chunk in stream:
            delta = chunk.choices[0].delta.content if chunk.choices else None
            if delta:
                got_any = True
                yield delta, "llm"
    except Exception:  # noqa: BLE001 — 网络/解析失败统一视为不可用
        if not got_any:
            yield fallback, "template"
            return
    if not got_any:
        yield fallback, "template"


async def json_complete(system: str, user: str, timeout: float = JSON_TIMEOUT) -> dict | None:
    """非流式单次完成，期望返回 JSON 对象（如结构化解析）。

    未配置 / 端点失败 / 输出无法解析 → None（由调用方决定降级），不冒充结果。
    """
    cfg = await _config()
    if cfg is None:
        return None
    try:
        resp = await _sdk(cfg, timeout=timeout, **(_client_kwargs or {})).chat.completions.create(
            model=cfg["model"],
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            temperature=0.1,
            stream=False,
        )
        content = resp.choices[0].message.content or ""
    except Exception:  # noqa: BLE001 — 网络/解析失败统一视为不可用
        return None
    m = re.search(r"\{[\s\S]*\}", content)
    if not m:
        return None
    try:
        data = json.loads(m.group(0))
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None
