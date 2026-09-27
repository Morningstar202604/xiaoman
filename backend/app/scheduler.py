"""定时晨报（APScheduler）：每天按设置时间生成一次财务概况并归档。

- 报告时间存 settings.report_time（HH:MM），保存设置后立即重排。
- 报告走同一条问答服务（确定性模板或模型），归档 thread_id='cron'。
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

from . import db, service

REPORT_QUESTION = "生成今日晨报：帮我体检并汇总组合、账本与财务目标的现状，只描述事实与风险提示，不给操作建议。"

_sched: AsyncIOScheduler | None = None
_state: dict[str, Any] = {
    "enabled": False,
    "report_time": "08:00",
    "last_run_at": None,
    "next_run_at": None,
    "last_error": None,
    "generated": 0,
}


def _parse_time(value: str | None) -> tuple[int, int] | None:
    if not value or ":" not in value:
        return None
    try:
        h, m = value.strip().split(":")
        hh, mm = int(h), int(m)
        if not (0 <= hh <= 23 and 0 <= mm <= 59):
            return None
        return hh, mm
    except (ValueError, TypeError):
        return None


async def has_data() -> bool:
    """库中是否已有持仓或流水（空库不生成无意义的晨报）。"""
    if await db.list_positions():
        return True
    return bool(await db.fetch_all("SELECT 1 FROM transactions LIMIT 1"))


async def generate_report() -> dict[str, Any]:
    """生成一次晨报并归档。手动触发（POST /api/reports/generate）与定时共用。

    空库时返回 skipped=True 并跳过归档：无内容的定时产出只是噪音。
    """
    events: list[dict[str, Any]] = []

    async def emit(e: dict[str, Any]) -> None:
        events.append(e)

    if not await has_data():
        return {
            "skipped": True,
            "reason": "no_data",
            "answer": "",
            "level": "",
            "flags": [],
        }

    try:
        result = await service.run_question(REPORT_QUESTION, emit)
        await db.save_run(
            thread_id="cron",
            question=REPORT_QUESTION,
            answer=result["answer"],
            level=result["level"],
            flags=result["flags"],
            route=result.get("route", ""),
            llm=result.get("llm", ""),
            route_reason=result.get("route_reason", ""),
        )
        _state["generated"] += 1
        _state["last_run_at"] = datetime.now().astimezone().isoformat(timespec="seconds")
        _state["last_error"] = None
        return result
    except Exception as exc:  # noqa: BLE001 — 晨报失败只记录，不炸服务
        _state["last_error"] = f"{type(exc).__name__}: {exc}"
        raise


def _reschedule() -> None:
    global _sched
    if _sched is None:
        return
    _sched.remove_all_jobs()
    hm = _parse_time(_state.get("report_time"))
    if hm is None:
        _sched.add_job(_cron_job, trigger="interval", minutes=1440, id="morning_report")
        _state["next_run_at"] = "（周期 24h 兜底）"
        return
    h, m = hm
    _sched.add_job(_cron_job, CronTrigger(hour=h, minute=m, timezone="Asia/Shanghai"), id="morning_report")
    _state["next_run_at"] = f"每天 {h:02d}:{m:02d}"


async def _cron_job() -> None:
    try:
        await generate_report()
    except Exception:  # noqa: BLE001 — 已由 generate_report 记录
        pass


async def notify_settings_changed() -> None:
    """设置保存后调用：读最新报告时间并重排。"""
    st = await db.get_settings()
    _state["report_time"] = st.get("report_time", "08:00")
    _reschedule()


async def start() -> None:
    global _sched
    if _sched is not None:
        return
    st = await db.get_settings()
    _state["report_time"] = st.get("report_time", "08:00")
    _sched = AsyncIOScheduler(timezone="Asia/Shanghai")
    _reschedule()
    _sched.start()
    _state["enabled"] = True


async def stop() -> None:
    global _sched
    if _sched is not None:
        _sched.shutdown(wait=False)
    _sched = None
    _state["enabled"] = False


def status() -> dict[str, Any]:
    return {
        "enabled": _state["enabled"],
        "report_time": _state.get("report_time", "08:00"),
        "last_run_at": _state["last_run_at"],
        "next_run_at": _state["next_run_at"],
        "last_error": _state["last_error"],
        "generated": _state["generated"],
    }
