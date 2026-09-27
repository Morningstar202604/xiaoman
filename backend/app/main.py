"""FastAPI 入口：REST + SSE 流式问答 + 最小鉴权 + 静态前端托管。

鉴权：设置 API_TOKEN 后，所有 /api/* 需带 `Authorization: Bearer <口令>`
或查询参数 `?token=<口令>`；未设置则仅限本机/内网使用。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import secrets
import uuid
from contextlib import asynccontextmanager, suppress
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import analysis, db, llm, quotes, scheduler, service
from .quotes import invalidate_quotes_cache

log = logging.getLogger(__name__)

APP_DIR = Path(__file__).resolve().parent
PROJECT_DIR = APP_DIR.parent.parent  # 仓库根目录（wealth-office 历史名）
FRONTEND_DIST = PROJECT_DIR / "frontend" / "dist"


@asynccontextmanager
async def lifespan(_: FastAPI):
    await db.init_db()
    await scheduler.start()
    yield
    await scheduler.stop()
    await llm.aclose()
    await db.close_db()


app = FastAPI(title="小满 API", version="1.0.0", lifespan=lifespan)

_dev_origins = {"http://127.0.0.1:5199", "http://localhost:5199"}
if os.getenv("CORS_ALLOW_ALL") == "1":  # 仅调试用
    _dev_origins = None
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(_dev_origins) if _dev_origins is not None else ["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# 最小鉴权：API_TOKEN 未设置 = 开放（仅限本机/内网）；设置后所有 /api/* 需带口令
# ---------------------------------------------------------------------------


@app.middleware("http")
async def api_auth(request: Request, call_next):
    path = request.url.path
    if path.startswith("/api/") and path != "/api/health":
        key = os.getenv("API_TOKEN", "").strip()
        if key:
            token = request.query_params.get("token", "")
            header = request.headers.get("authorization", "")
            if not (
                secrets.compare_digest(token, key)
                or secrets.compare_digest(header, f"Bearer {key}")
            ):
                return JSONResponse({"error": "需要访问口令"}, status_code=401)
    return await call_next(request)


# ---------------------------------------------------------------------------
# 无口令模式的 Host/Origin 防护（DNS rebinding / 跨站读取）：
# 未设 API_TOKEN 时仅放行本机与 ALLOWED_HOSTS 白名单；/api/health 恒免检；
# 设了口令则以口令为准（反代部署不拦截）。注册在 api_auth 之后 = 更外层。
# ---------------------------------------------------------------------------

_LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1", "[::1]", "testserver"}


def _hostname(value: str) -> str:
    """剥离端口的主机名（支持 host:port 与 [v6]:port）。"""
    v = (value or "").strip().lower()
    if v.startswith("["):
        return v.split("]", 1)[0] + "]"
    return v.rsplit(":", 1)[0] if v.count(":") == 1 else v


def _allowed_hosts() -> set[str]:
    extra = {
        h.strip().lower()
        for h in os.getenv("ALLOWED_HOSTS", "").split(",")
        if h.strip()
    }
    return _LOCAL_HOSTS | extra


@app.middleware("http")
async def host_guard(request: Request, call_next):
    path = request.url.path
    if (
        path.startswith("/api/")
        and path != "/api/health"
        and not os.getenv("API_TOKEN", "").strip()
    ):
        allowed = _allowed_hosts()
        host = _hostname(request.headers.get("host", ""))
        if host and host not in allowed:
            return JSONResponse(
                {
                    "error": "不允许的 Host：未设置 API_TOKEN 时仅限本机/内网访问，"
                    "如需按主机名部署请设置 ALLOWED_HOSTS 或 API_TOKEN"
                },
                status_code=403,
            )
        origin = request.headers.get("origin", "")
        if origin:
            oh = (urlsplit(origin).hostname or "").lower()
            if oh and oh not in allowed and oh != host:
                return JSONResponse({"error": "不允许的 Origin"}, status_code=403)
    return await call_next(request)


# ---------------------------------------------------------------------------
# 健康 / 引导 / 仪表盘
# ---------------------------------------------------------------------------


@app.get("/api/health")
async def health() -> dict:
    return {
        "ok": True,
        "llm_configured": await llm.llm_available(),
        "model": await _llm_model(),
    }


async def _llm_model() -> str:
    try:
        s = await db.get_settings()
        return (s.get("ai_model") or "").strip() or os.getenv("LLM_MODEL", "")
    except Exception:  # noqa: BLE001
        return os.getenv("LLM_MODEL", "")


@app.get("/api/bootstrap")
async def bootstrap() -> dict:
    settings = await db.get_settings()
    return {
        "settings": settings,
        "scheduler": scheduler.status(),
        "health": {
            "llm_configured": await llm.llm_available(),
            "model": await _llm_model(),
        },
        "source": (await analysis.collect_dashboard())["source"],
    }


@app.get("/api/dashboard")
async def dashboard() -> dict:
    return await analysis.collect_dashboard()


# ---------------------------------------------------------------------------
# 数据录入（持仓 / 流水 / 负债）
# ---------------------------------------------------------------------------


@app.post("/api/positions")
async def create_position(payload: dict) -> dict:
    try:
        out = await db.add_position(payload or {})
    except Exception as exc:  # noqa: BLE001 — 坏输入回 400
        return JSONResponse({"error": str(exc)}, status_code=400)
    await invalidate_quotes_cache()
    return out


@app.delete("/api/positions/{symbol}")
async def remove_position(symbol: str) -> dict:
    out = await db.delete_position(symbol)
    await invalidate_quotes_cache()
    return out


@app.post("/api/transactions")
async def create_transaction(payload: dict) -> dict:
    import re

    date = str(payload.get("date") or "").strip()
    item = str(payload.get("item") or "").strip()
    category = str(payload.get("category") or "其他").strip() or "其他"
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        return JSONResponse({"error": "日期需为 YYYY-MM-DD 格式"}, status_code=400)
    if not item:
        return JSONResponse({"error": "名称必填"}, status_code=400)
    try:
        amount = float(payload.get("amount", 0) or 0)
    except (TypeError, ValueError):
        return JSONResponse({"error": "金额不合法"}, status_code=400)
    if amount == 0:
        return JSONResponse({"error": "金额不能为 0"}, status_code=400)
    try:
        return await db.add_transaction(date, item, category, amount)
    except Exception as exc:  # noqa: BLE001
        return JSONResponse({"error": str(exc)}, status_code=400)


@app.delete("/api/transactions/{tx_id}")
async def remove_transaction(tx_id: int) -> dict:
    return await db.delete_transaction(tx_id)


@app.post("/api/nl-add")
async def nl_add(payload: dict) -> dict:
    """一句话记账：规则解析优先（秒回），规则拿不到金额时升级 AI，AI 也失败则 422 提示。"""
    from . import nlparse

    text = str((payload or {}).get("text") or "").strip()
    if not text:
        return JSONResponse({"error": "请输入一句话记账内容"}, status_code=400)

    parsed = nlparse.parse(text)
    source = "rule"
    if parsed is None:
        # 规则拿不到金额 → AI 兜底
        parsed = await nlparse.parse_with_ai(text)
        source = "ai" if parsed else None
    elif parsed["category"] == "其他" and parsed["amount"] < 0:
        # 规则拿到金额但分类不明确（非收入）→ AI 补分类，失败仍用规则结果入账
        ai = await nlparse.parse_with_ai(text)
        if ai is not None:
            parsed, source = ai, "ai"
    if parsed is None:
        return JSONResponse(
            {
                "error": "没读懂这句话，试试「昨天打车 32 元」「工资 8000 已到账」这样的说法"
            },
            status_code=422,
        )
    try:
        ins = await db.add_transaction(
            parsed["date"], parsed["item"], parsed["category"], parsed["amount"]
        )
        rows = await db.fetch_all("SELECT * FROM transactions WHERE id=?", (ins["id"],))
        tx = rows[0] if rows else {"id": ins["id"], **parsed}
    except Exception as exc:  # noqa: BLE001
        return JSONResponse({"error": str(exc)}, status_code=400)
    return {"ok": True, "source": source, "transaction": tx}


# ---------------------------------------------------------------------------
# 账单导入（CSV）
# ---------------------------------------------------------------------------


@app.post("/api/import/csv")
async def import_csv_parse(payload: dict) -> dict:
    """解析 CSV → 识别列映射 + 预览（前 15 条）+ 可导入条数统计。"""
    from . import csvimport

    content = str((payload or {}).get("content") or "").strip()
    if not content:
        return JSONResponse({"error": "请粘贴账单 CSV 内容"}, status_code=400)
    try:
        parsed = csvimport.parse_csv(content)
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)
    mapping = csvimport.detect_mapping(parsed["columns"])
    if mapping["amount"] < 0 or mapping["date"] < 0:
        return JSONResponse(
            {"error": "没能识别出日期/金额列，请确认表头包含「日期」「金额」等关键词"},
            status_code=422,
        )
    year = datetime.now().astimezone().strftime("%Y-%m")
    rows, skips = csvimport.build_rows(
        mapping, parsed["columns"], parsed["rows"], year_fill=year
    )
    return {
        "ok": True,
        "columns": parsed["columns"],
        "mapping": mapping,
        "preview": rows[:15],
        "rows": rows,
        "total": len(rows),
        "skipped": len(skips),
    }


@app.post("/api/import/commit")
async def import_csv_commit(payload: dict) -> dict:
    """按前端确认的 rows 批量入账；逐条校验，坏行计入失败数。"""
    rows = (payload or {}).get("rows")
    if not isinstance(rows, list) or not rows:
        return JSONResponse({"error": "没有可导入的数据"}, status_code=400)
    ok, failed = 0, []
    for r in rows:
        if not isinstance(r, dict):
            failed.append("非法行")
            continue
        date = str(r.get("date") or "").strip()
        item = str(r.get("item") or "其他").strip()[:40] or "其他"
        category = str(r.get("category") or "其他").strip() or "其他"
        try:
            amount = float(r.get("amount", 0) or 0)
        except (TypeError, ValueError):
            failed.append(item)
            continue
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date) or amount == 0:
            failed.append(item)
            continue
        try:
            await db.add_transaction(date, item, category, amount)
            ok += 1
        except Exception:  # noqa: BLE001 — 单行失败不影响整体
            failed.append(item)
    return {"ok": True, "imported": ok, "failed": failed}


# ---------------------------------------------------------------------------
# 预算
# ---------------------------------------------------------------------------


def _current_month() -> str:
    return datetime.now().astimezone().strftime("%Y-%m")


# 预算统计不计入的分类：储蓄与转移支付
NON_CONSUMPTION_CATEGORIES = ("投资", "还款")


@app.get("/api/budgets")
async def get_budgets(month: str | None = None) -> dict:
    """返回指定月（默认本月）的预算设置 + 实时使用情况。"""
    m = (month or "").strip() or _current_month()
    rows = await db.list_budgets(m)
    budgets = [
        {
            "category": "总预算" if r["category"] == "__total" else r["category"],
            "key": r["category"],
            "amount": r["amount"],
        }
        for r in rows
    ]
    spent_by_cat = await db.month_expense_by_category(m)
    # 预算口径：投资/还款是储蓄与转移支付，不是消费支出，不计入预算使用
    for cat in NON_CONSUMPTION_CATEGORIES:
        spent_by_cat.pop(cat, None)
    total_spent = round(sum(spent_by_cat.values()), 2)
    total_budget = next((r["amount"] for r in rows if r["category"] == "__total"), 0.0)

    cat_usage = []
    for b in budgets:
        key = b["key"]
        if key == "__total":
            continue
        spent = round(spent_by_cat.get(key, 0.0), 2)
        cat_usage.append(
            {
                "category": b["category"],
                "budget": b["amount"],
                "spent": spent,
                "pct": round(spent / b["amount"] * 100, 1) if b["amount"] else 0,
                "over": spent > b["amount"],
            }
        )

    total_pct = round(total_spent / total_budget * 100, 1) if total_budget else 0
    # 剩余日均：余量 / 本月剩余天数（含今天）
    now = datetime.now().astimezone()
    next_month = datetime(
        now.year + (now.month == 12), (now.month % 12) + 1, 1, tzinfo=now.tzinfo
    )
    days_left = max(
        1, (next_month - now.replace(hour=0, minute=0, second=0, microsecond=0)).days
    )
    left_daily = (
        round((total_budget - total_spent) / days_left, 2) if total_budget else 0.0
    )

    return {
        "month": m,
        "budgets": budgets,
        "usage": {
            "total_budget": total_budget,
            "total_spent": total_spent,
            "total_pct": total_pct,
            "over": total_budget > 0 and total_spent > total_budget,
            "left": round(total_budget - total_spent, 2),
            "left_daily": left_daily,
            "days_left": days_left,
            "categories": cat_usage,
        },
    }


@app.put("/api/budgets")
async def put_budgets(payload: dict) -> dict:
    month = (payload or {}).get("month") or _current_month()
    if not re.fullmatch(r"(20\d{2}|19\d{2})-(0[1-9]|1[0-2])", month):
        return JSONResponse({"error": "月份需为 YYYY-MM（01–12）"}, status_code=400)
    items = (payload or {}).get("budgets")
    if not isinstance(items, list):
        return JSONResponse({"error": "budgets 需为数组"}, status_code=400)
    clean_map: dict[str, float] = {}
    for it in items:
        if not isinstance(it, dict):
            continue
        try:
            amt = float(it.get("amount", 0) or 0)
        except (TypeError, ValueError):
            return JSONResponse({"error": "预算金额不合法"}, status_code=400)
        if amt > 0:
            # 同分类后一项覆盖前一项（upsert 语义），避免主键冲突
            clean_map[str(it.get("category", "__total"))] = amt
    clean = [{"category": k, "amount": v} for k, v in clean_map.items()]
    await db.save_budgets(month, clean)
    return {"ok": True, "month": month, "count": len(clean)}


@app.post("/api/debts")
async def create_debt(payload: dict) -> dict:
    try:
        out = await db.add_debt(payload or {})
    except Exception as exc:  # noqa: BLE001
        return JSONResponse({"error": str(exc)}, status_code=400)
    return out


@app.delete("/api/debts/{name}")
async def remove_debt(name: str) -> dict:
    return await db.delete_debt(name)


@app.post("/api/subscriptions")
async def create_subscription(payload: dict) -> dict:
    try:
        out = await db.add_subscription(payload or {})
    except Exception as exc:  # noqa: BLE001
        return JSONResponse({"error": str(exc)}, status_code=400)
    return out


@app.delete("/api/subscriptions/{name}")
async def remove_subscription(name: str) -> dict:
    out = await db.delete_subscription(name)
    return out


# ---------------------------------------------------------------------------
# 财务目标（goals）
# ---------------------------------------------------------------------------


@app.get("/api/goals")
async def goals_list() -> dict:
    return {"goals": analysis.goal_progress(await db.list_goals())}


@app.post("/api/goals")
async def create_goal(payload: dict) -> dict:
    try:
        out = await db.add_goal(payload or {})
    except Exception as exc:  # noqa: BLE001 — 坏输入回 400
        return JSONResponse({"error": str(exc)}, status_code=400)
    return out


@app.put("/api/goals/{name}")
async def update_goal(name: str, payload: dict) -> dict:
    try:
        out = await db.update_goal(name, payload or {})
    except Exception as exc:  # noqa: BLE001
        return JSONResponse({"error": str(exc)}, status_code=400)
    return out


@app.delete("/api/goals/{name}")
async def remove_goal(name: str) -> dict:
    return await db.delete_goal(name)


# ---------------------------------------------------------------------------
# 长期记忆（user_memory）
# ---------------------------------------------------------------------------


@app.get("/api/memory")
async def memory_list() -> dict:
    return {"memory": await db.list_memory()}


@app.post("/api/memory")
async def create_memory(payload: dict) -> dict:
    try:
        out = await db.add_memory(str((payload or {}).get("content") or "").strip())
    except Exception as exc:  # noqa: BLE001
        return JSONResponse({"error": str(exc)}, status_code=400)
    return out


@app.delete("/api/memory/{mem_id}")
async def remove_memory(mem_id: int) -> dict:
    return await db.delete_memory(mem_id)


@app.post("/api/memory/clear")
async def clear_memory() -> dict:
    return await db.clear_memory()


# ---------------------------------------------------------------------------
# 财务体检（health check）
# ---------------------------------------------------------------------------


@app.get("/api/health-check")
async def health_check() -> dict:
    positions = await db.list_positions()
    # 空库保护与图内一致：没有任何持仓/流水时不给「分数体检」假象
    if not positions and not await db.fetch_all("SELECT 1 FROM transactions LIMIT 1"):
        return analysis.health_check(None, None, [], await db.list_goals())
    live = await quotes.live_quotes(positions)
    settings = await db.get_settings()
    m = analysis.market_view(positions, live)
    led = analysis.ledger_view(
        await db.list_transactions(),
        await db.list_subscriptions(),
        await db.list_debts(),
        settings,
        positions,
        live,
    )
    flags = analysis.risk_checks(m, led)
    return analysis.health_check(m, led, flags, await db.list_goals())


@app.post("/api/portfolio/reset")
async def reset_portfolio() -> dict:
    out = await db.reset_to_seed()
    await invalidate_quotes_cache()
    return out


# ---------------------------------------------------------------------------
# 设置
# ---------------------------------------------------------------------------

NUMERIC_KEYS = (
    "monthly_income",
    "emergency_target_months",
    "savings_goal",
    "auto_refresh_seconds",
)
QUOTE_MODES = ("auto", "snapshot", "eastmoney")
ONOFF_KEYS = (
    "voice_input",
    "show_export",
    "expand_process",
    "show_suggestions",
    "auto_refresh",
    "compact_numbers",
    "ai_enabled",
)
# AI 配置：文本直存（key 仅存本机数据库）
AI_TEXT_KEYS = ("ai_base_url", "ai_api_key", "ai_model")
NUMERIC_RANGES: dict[str, tuple[float, float]] = {
    "monthly_income": (0, 1e12),
    "emergency_target_months": (0, 120),
    "savings_goal": (0, 100),
    "auto_refresh_seconds": (30, 86400),
}


@app.get("/api/settings")
async def get_settings() -> dict:
    return {"settings": await db.get_settings(), "scheduler": scheduler.status()}


@app.put("/api/settings")
async def put_settings(payload: dict) -> dict:
    updates = (payload or {}).get("settings")
    if not isinstance(updates, dict) or not updates:
        return JSONResponse({"error": "settings 对象必填"}, status_code=400)

    applied: dict[str, str] = {}
    errors: list[str] = []
    for key, raw in updates.items():
        if key in NUMERIC_KEYS:
            try:
                v = float(raw)
                lo, hi = NUMERIC_RANGES[key]
                if v < lo or v > hi:
                    errors.append(f"{key} 需在 {lo:g}–{hi:g} 之间")
                    continue
                applied[key] = str(int(v)) if float(v).is_integer() else str(v)
            except (TypeError, ValueError):
                errors.append(f"{key} 的值不合法：{raw!r}")
        elif key in ONOFF_KEYS:
            if raw not in ("on", "off"):
                errors.append(f"{key} 只能是 on/off")
                continue
            applied[key] = raw
        elif key == "quote_source_mode":
            if raw not in QUOTE_MODES:
                errors.append(f"行情源只能是 {'/'.join(QUOTE_MODES)}")
                continue
            applied[key] = raw
        elif key == "report_time":
            import re

            if not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", str(raw).strip()):
                errors.append("晨报时间需为 HH:MM（24 小时制）")
                continue
            applied[key] = str(raw).strip()
        elif key == "essential_categories":
            cats = [c.strip() for c in str(raw).split(",") if c.strip()]
            if not cats:
                errors.append("必要支出类别不能为空")
                continue
            applied[key] = ",".join(cats)
        elif key in AI_TEXT_KEYS:
            v = str(raw).strip()
            if key == "ai_base_url" and v and not v.startswith(("http://", "https://")):
                errors.append("AI 接口地址需以 http:// 或 https:// 开头")
                continue
            applied[key] = v[:500]
        else:
            errors.append(f"未知配置项：{key}")

    for k, v in applied.items():
        await db.set_setting(k, v)
    # AI 配置变化后使 llm 重新读取
    if any(
        k in applied for k in ("ai_enabled", "ai_base_url", "ai_api_key", "ai_model")
    ):
        llm.invalidate()
    if "quote_source_mode" in applied:
        await invalidate_quotes_cache()
    if "report_time" in applied:
        await scheduler.notify_settings_changed()
    return {
        "ok": True,
        "applied": applied,
        "errors": errors,
        "settings": await db.get_settings(),
    }


# ---------------------------------------------------------------------------
# 问答：SSE 流式
# ---------------------------------------------------------------------------


def sse(obj: dict) -> str:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"


async def _sse_stream(first: dict | None, runner) -> StreamingResponse:
    """把 runner(emit, put) 产生的事件转成 SSE；断连时取消任务，不继续 yield。

    first 可选：仅当调用方需要在 runner 之前先发一帧时使用。
    事件契约由 service 拥有（如 start），API 层不重复发。
    """

    async def event_stream():
        queue: asyncio.Queue = asyncio.Queue()

        async def emit(event: dict) -> None:
            await queue.put({"type": "event", **event})

        async def run() -> None:
            try:
                await runner(emit)
            except Exception as exc:  # noqa: BLE001 — 让前端看到真实错误
                await queue.put(
                    {"type": "error", "message": f"{type(exc).__name__}: {exc}"}
                )
            finally:
                await queue.put(None)

        task = asyncio.create_task(run())
        if first is not None:
            yield sse(first)
        try:
            while True:
                item = await queue.get()
                if item is None:
                    break
                yield sse(item)
            yield sse({"type": "done"})
        finally:
            if not task.done():
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/ask")
async def ask(payload: dict):
    question = ((payload or {}).get("question") or "").strip()
    if not question:
        return JSONResponse({"error": "question required"}, status_code=400)
    thread_id = ((payload or {}).get("thread_id") or "").strip() or uuid.uuid4().hex
    regenerate = bool((payload or {}).get("regenerate"))

    async def runner(emit) -> None:
        # 重新生成：先移除该会话最后一条问答，再以同一问题重新作答（替换而非追加）
        if regenerate:
            try:
                await db.delete_last_run(thread_id, question)
            except Exception:  # noqa: BLE001 — 删除失败则退化为普通追加
                log.exception("delete_last_run failed")
        result = await service.run_question(question, emit, thread_id=thread_id)
        try:
            await db.save_run(
                thread_id=thread_id,
                question=question,
                answer=result["answer"],
                level=result["level"],
                flags=result["flags"],
                route=result.get("route", ""),
                llm=result.get("llm", ""),
                route_reason=result.get("route_reason", ""),
                tools=result.get("tools") or [],
            )
        except Exception:  # noqa: BLE001 — 落库失败不打断交付
            log.exception("save_run failed")
        await emit(
            {
                "type": "final",
                "answer": result["answer"],
                "level": result["level"],
                "route": result["route"],
                "route_reason": result["route_reason"],
                "metrics": result["metrics"],
                "flags": result["flags"],
                "llm": result["llm"],
                "tools": result.get("tools") or [],
            }
        )

    # start 事件由 service.run_question 发出（事件契约归 service），此处不再重复发首帧
    return await _sse_stream(None, runner)


# ---------------------------------------------------------------------------
# 历史 / 晨报
# ---------------------------------------------------------------------------


@app.get("/api/history")
async def history(thread_id: str | None = None, limit: int = 50) -> dict:
    return {"runs": await db.list_runs(thread_id, limit)}


# ---------------------------------------------------------------------------
# 会话管理（多会话）
# ---------------------------------------------------------------------------


@app.get("/api/sessions")
async def sessions() -> dict:
    return {"sessions": await db.list_sessions()}


@app.post("/api/sessions")
async def create_session(payload: dict | None = None) -> dict:
    title = str((payload or {}).get("title") or "新会话").strip()
    return await db.create_session(title=title)


@app.patch("/api/sessions/{session_id}")
async def rename_session(session_id: int, payload: dict) -> dict:
    title = str(payload.get("title") or "").strip()
    if not title:
        return JSONResponse({"error": "标题不能为空"}, status_code=400)
    return await db.rename_session(session_id, title)


@app.delete("/api/sessions/{session_id}")
async def delete_session(session_id: int) -> dict:
    return await db.delete_session(session_id)


# ---------------------------------------------------------------------------
# 数据导出 / 导入恢复 / 月度趋势
# ---------------------------------------------------------------------------


@app.get("/api/export")
async def export_data() -> dict:
    return await db.export_data()


@app.post("/api/import/backup")
async def import_backup(payload: dict) -> dict:
    """从 /api/export 的 JSON 恢复全量数据（AI Key 除外，需重新填写）。"""
    data = payload or {}
    if not isinstance(data, dict):
        return JSONResponse({"error": "备份格式不正确"}, status_code=400)
    version = str((data.get("meta") or {}).get("version") or data.get("version") or "")
    if not (version.startswith(("wealth-office-v", "xiaoman-v")) or version == "2"):
        return JSONResponse({"error": f"备份格式不被识别（version={version or '空'}）"}, status_code=400)
    try:
        counts = await db.import_backup(data)
    except Exception as exc:  # noqa: BLE001 — 恢复失败要回滚并给可读错误
        log.exception("import backup failed")
        return JSONResponse({"error": f"恢复失败，数据已回滚：{exc}"}, status_code=400)
    await invalidate_quotes_cache()
    return {"ok": True, "counts": counts}


@app.get("/api/export/csv")
async def export_csv() -> StreamingResponse:
    """流水导出为 CSV（带 BOM，Excel 直接打开不乱码）。"""
    import csv
    import io

    rows = await db.list_transactions()
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["日期", "项目", "分类", "金额"])
    for r in rows:
        writer.writerow([r["date"], r["item"], r["category"], r["amount"]])
    data = "\ufeff" + buf.getvalue()
    return StreamingResponse(
        iter([data]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="ledger.csv"'},
    )


@app.get("/api/kline")
async def kline(symbol: str, period: str = "daily", limit: int = 120) -> dict:
    """某标的 K 线（A股/ETF）。period: daily/weekly/monthly。"""
    try:
        out = await quotes.kline(symbol, period, max(10, min(limit, 500)))
    except Exception as exc:  # noqa: BLE001
        return JSONResponse({"error": str(exc)}, status_code=502)
    if not out:
        return JSONResponse({"error": f"无法获取 {symbol} 行情"}, status_code=404)
    return out


@app.get("/api/trend")
async def trend(months: int = 6) -> dict:
    return {"months": await db.monthly_trend(max(1, min(months, 24)))}


@app.get("/api/reports")
async def reports(limit: int = 20) -> dict:
    return {"reports": await db.list_runs("cron", limit)}


@app.post("/api/reports/generate")
async def generate_report_now() -> dict:
    try:
        result = await scheduler.generate_report()
    except Exception as exc:  # noqa: BLE001 — 手动触发失败要给可读错误
        return JSONResponse({"ok": False, "error": str(exc)}, status_code=500)
    if result.get("skipped"):
        # 空库不生成（前端据此提示「还没有数据」而非假装成功）
        return {"ok": True, "skipped": True, "reason": result.get("reason", "no_data")}
    return {"ok": True, "answer": result["answer"], "level": result["level"]}


@app.get("/api/scheduler")
async def scheduler_status() -> dict:
    return scheduler.status()


# ---------------------------------------------------------------------------
# 静态前端托管（同域单端口）
# ---------------------------------------------------------------------------

if FRONTEND_DIST.is_dir():

    @app.get("/", include_in_schema=False)
    async def index() -> FileResponse:
        return FileResponse(
            FRONTEND_DIST / "index.html",
            headers={"Cache-Control": "no-store"},
        )

    app.mount("/", StaticFiles(directory=str(FRONTEND_DIST), html=True), name="web")
else:

    @app.get("/", include_in_schema=False)
    async def placeholder() -> dict:
        return {"message": "前端未构建：cd frontend && npm install && npm run build"}
