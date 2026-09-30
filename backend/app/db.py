"""组合库 + 运行历史持久化（aiosqlite，单连接串行，不阻塞事件循环）。

所有函数都是异步的；连接在启动时创建（WAL 模式）。
首次运行自动建表。全新库为**空账本**（不种示例数据）：用户从记第一笔/添加持仓开始；
示例数据仅在设置页显式"导入示例数据"时种入（演示用）。
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

import aiosqlite

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "wealth.db"

_db: aiosqlite.Connection | None = None
_inited = False

# --------------------------------------------------------------------------
# 种子数据：一套典型中产家庭的示例（用户可在"记账"页改成自己的真实数据）
# --------------------------------------------------------------------------

SEED_POSITIONS = [
    {
        "symbol": "600519",
        "name": "贵州茅台",
        "kind": "股票",
        "industry": "白酒",
        "shares": 100,
        "cost": 1680.00,
        "last": 1521.00,
    },
    {
        "symbol": "510300",
        "name": "沪深300ETF",
        "kind": "ETF",
        "industry": "宽基指数",
        "shares": 8000,
        "cost": 3.85,
        "last": 4.06,
    },
    {
        "symbol": "110011",
        "name": "易方达中小盘混合",
        "kind": "基金",
        "industry": "主动权益",
        "shares": 12000,
        "cost": 4.10,
        "last": 3.58,
    },
    {
        "symbol": "CASH",
        "name": "活期现金",
        "kind": "现金",
        "industry": "现金",
        "shares": 1,
        "cost": 55000.00,
        "last": 55000.00,
    },
]

# day_in_month: 尽量落在本月已过去的日期（今日之前），保证"本月"口径成立
SEED_TRANSACTIONS = [
    (2, "工资入账", "收入", 24800.0),
    (3, "房租", "居住", -5200.0),
    (5, "外卖餐饮", "餐饮", -1860.0),
    (7, "视频会员（年付）", "订阅", -258.0),
    (9, "通勤地铁", "交通", -320.0),
    (11, "健身私教", "订阅", -1999.0),
    (13, "添置家电", "购物", -4300.0),
    (15, "基金定投", "投资", -3000.0),
    (17, "云盘会员", "订阅", -168.0),
    (19, "聚餐", "餐饮", -960.0),
    (20, "信用卡还款", "还款", -3200.0),
]

SEED_SUBSCRIPTIONS = [
    {"name": "云盘会员", "monthly": 14.0, "note": "可合并到家庭共享", "due_day": "1"},
    {
        "name": "健身私教",
        "monthly": 1999.0,
        "note": "占订阅支出绝大部分",
        "due_day": "5",
    },
    {"name": "流媒体", "monthly": 21.5, "note": "与年付会员功能重叠", "due_day": "28"},
]

SEED_DEBTS = [
    {
        "name": "房贷",
        "monthly": 6800.0,
        "balance": 1280000.0,
        "rate": 0.0345,
        "due_day": "15",
    },
    {
        "name": "信用卡分期",
        "monthly": 900.0,
        "balance": 7200.0,
        "rate": 0.13,
        "due_day": "10",
    },
]

SEED_SETTINGS = {
    "monthly_income": "24800",
    "emergency_target_months": "6",
    # 应急金覆盖所需的"必要月支出"口径：居住 + 餐饮 + 交通 三类
    "essential_categories": "居住,餐饮,交通",
    # 行情源：auto（东财优先，失败降级快照）| snapshot | eastmoney
    "quote_source_mode": "auto",
    # 定时晨报时间（HH:MM）
    "report_time": "08:00",
    # ---- 功能开关（设置中心可自定义）----
    "voice_input": "off",  # 问答语音输入（浏览器支持时）
    "show_export": "on",  # 回答导出/复制按钮
    "expand_process": "off",  # 分析过程默认展开
    "show_suggestions": "off",  # 问答页建议入口（R4 起输入区常驻快捷指令 chips，空态建议默认关）
    "auto_refresh": "off",  # 仪表盘定时自动刷新
    "auto_refresh_seconds": "300",  # 自动刷新间隔（秒）
    "compact_numbers": "on",  # 大金额缩写（万/亿）
    "color_scheme": "cn",  # 涨跌颜色：cn 红涨绿跌（A股惯例）| us 绿涨红跌（海外惯例）
    "default_tab": "chat",  # 默认首页：overview|holdings|market|ledger|chat（对话中枢为主，可在设置改回）
    "savings_goal": "20",  # 储蓄率目标（%）
    # ---- AI 回答（OpenAI 兼容端点，可配任意国产/海外模型；失败自动降级模板）----
    "ai_enabled": "on",  # 是否启用 AI 回答（AI 优先；三要素未配或调用失败时回退内置分析）
    "ai_base_url": "",  # 国产示例：DeepSeek https://api.deepseek.com/v1 · 豆包 https://ark.cn-beijing.volces.com/api/v3 · 通义 https://dashscope.aliyuncs.com/compatible-mode/v1
    "ai_api_key": "",  # 仅存本机数据库
    "ai_model": "",  # 对应端点模型：deepseek-chat / doubao 接入点 ID / qwen-plus
    "data_note": "seed",
}

# 版本化默认设置：新增键时对已有库补齐默认值
DEFAULT_SETTINGS = {k: v for k, v in SEED_SETTINGS.items()}

SCHEMA = """
CREATE TABLE IF NOT EXISTS positions (
    symbol   TEXT PRIMARY KEY,
    name     TEXT NOT NULL,
    kind     TEXT NOT NULL DEFAULT '股票',
    industry TEXT NOT NULL DEFAULT '其他',
    shares   REAL NOT NULL,
    cost     REAL NOT NULL,
    last     REAL NOT NULL,
    buy_date TEXT,
    fee      REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS transactions (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    date     TEXT NOT NULL,
    item     TEXT NOT NULL,
    category TEXT NOT NULL,
    amount   REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tx_month ON transactions(date);
CREATE TABLE IF NOT EXISTS subscriptions (
    name    TEXT PRIMARY KEY,
    monthly REAL NOT NULL,
    note    TEXT NOT NULL DEFAULT '',
    due_day TEXT NOT NULL DEFAULT ''   -- 每月几号扣款（'' 表示未设置）
);
CREATE TABLE IF NOT EXISTS debts (
    name     TEXT PRIMARY KEY,
    monthly  REAL NOT NULL,
    balance  REAL NOT NULL,
    rate     REAL NOT NULL,
    due_day  TEXT NOT NULL DEFAULT ''  -- 每月几号还款（'' 表示未设置）
);
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS budgets (
    month    TEXT NOT NULL,   -- YYYY-MM
    category TEXT NOT NULL,   -- __total 表示总预算，其余为分类预算
    amount   REAL NOT NULL,
    PRIMARY KEY (month, category)
);
CREATE TABLE IF NOT EXISTS runs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id     TEXT NOT NULL,
    question      TEXT NOT NULL,
    answer        TEXT NOT NULL,
    level         TEXT NOT NULL DEFAULT '',
    flags_json    TEXT NOT NULL DEFAULT '[]',
    created_at    TEXT NOT NULL,
    route         TEXT NOT NULL DEFAULT '',
    llm           TEXT NOT NULL DEFAULT '',
    route_reason  TEXT NOT NULL DEFAULT '',
    tools         TEXT NOT NULL DEFAULT '',
    actions       TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_runs_thread ON runs(thread_id, id);
CREATE TABLE IF NOT EXISTS sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id  TEXT UNIQUE NOT NULL,
    title      TEXT NOT NULL DEFAULT '新会话',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS goals (
    name       TEXT PRIMARY KEY,
    target     REAL NOT NULL,
    saved      REAL NOT NULL DEFAULT 0,
    deadline   TEXT NOT NULL DEFAULT '',   -- 目标月份 YYYY-MM（'' 未设）
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS watchlist (
    symbol     TEXT PRIMARY KEY,
    name       TEXT NOT NULL DEFAULT '',
    kind       TEXT NOT NULL DEFAULT '股票',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS user_memory (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,    content    TEXT NOT NULL,
    kind       TEXT NOT NULL DEFAULT 'fact', -- fact / preference / goal_related
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
"""


def _seed_date(day: int) -> str:
    """种子流水的日期：本月已过去的日期（不晚于今天）。"""
    now = datetime.now()
    return now.replace(day=min(day, now.day)).strftime("%Y-%m-%d")


async def init_db() -> None:
    global _db, _inited
    if _inited:
        return
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    _db = await aiosqlite.connect(str(DB_PATH))
    _db.row_factory = aiosqlite.Row
    await _db.execute("PRAGMA journal_mode=WAL")
    await _db.executescript(SCHEMA)
    await _migrate_add_columns()
    # 全新库（settings 表为空）不再自动种示例：空账本起步，用户自己记账/加持仓。
    # 老库即使用户清空了数据也绝不重置；示例数据只能显式导入（设置页/演示 API）。
    await _ensure_defaults()
    if await _count("positions") == 0:
        conn = await _conn()
        row = await (await conn.execute("SELECT value FROM settings WHERE key='data_note'")).fetchone()
        if row and str(row["value"]).startswith("seed"):
            # 若旧库被清空但 data_note 仍是 seed，降级为 empty，避免误标示例
            await conn.execute(
                "INSERT INTO settings(key,value) VALUES('data_note','empty') "
                "ON CONFLICT(key) DO UPDATE SET value='empty'"
            )
            await conn.commit()
    await _migrate_sessions_from_runs()
    await _db.commit()
    _inited = True


async def _migrate_add_columns() -> None:
    """老库增量迁移：为已有表补新列（CREATE TABLE IF NOT EXISTS 不会改老表）。"""
    assert _db is not None
    cols = {
        "subscriptions": {"due_day": "TEXT NOT NULL DEFAULT ''"},
        "debts": {"due_day": "TEXT NOT NULL DEFAULT ''"},
        # 问答来源可溯源：route/llm 落库后历史回答也能显示真实来源（此前只能显示等级）
        "runs": {
            "route": "TEXT NOT NULL DEFAULT ''",
            "llm": "TEXT NOT NULL DEFAULT ''",
            "route_reason": "TEXT NOT NULL DEFAULT ''",
            "tools": "TEXT NOT NULL DEFAULT ''",
            "actions": "TEXT NOT NULL DEFAULT '[]'",
        },
    }
    for table, adds in cols.items():
        cur = await _db.execute(f"PRAGMA table_info({table})")
        existing = {row["name"] for row in await cur.fetchall()}
        for col, decl in adds.items():
            if col not in existing:
                await _db.execute(f"ALTER TABLE {table} ADD COLUMN {col} {decl}")


async def close_db() -> None:
    global _db, _inited
    if _db is not None:
        await _db.close()
    _db = None
    _inited = False


async def _conn() -> aiosqlite.Connection:
    if _db is None:
        await init_db()
    assert _db is not None
    return _db


def _clean_due_day(v: object) -> str:
    """扣款日归一化：'' / '1'..'31'；非法值返回 ''。"""
    s = str(v or "").strip()
    if s in {"", "0"}:
        return ""
    if s.isdigit() and 1 <= int(s) <= 31:
        return s
    return ""


async def _count(table: str) -> int:
    cur = await _db.execute(f"SELECT COUNT(*) AS n FROM {table}")
    row = await cur.fetchone()
    return int(row["n"]) if row else 0


async def _seed_all() -> None:
    assert _db is not None
    await _db.executemany(
        "INSERT INTO positions(symbol,name,kind,industry,shares,cost,last,buy_date,fee)"
        " VALUES(:symbol,:name,:kind,:industry,:shares,:cost,:last,:buy_date,:fee)",
        [{**p, "buy_date": None, "fee": 0.0} for p in SEED_POSITIONS],
    )
    await _db.executemany(
        "INSERT INTO transactions(date,item,category,amount) VALUES(?,?,?,?)",
        [(_seed_date(d), item, cat, amt) for d, item, cat, amt in SEED_TRANSACTIONS],
    )
    await _db.executemany(
        "INSERT INTO subscriptions(name,monthly,note,due_day) VALUES(:name,:monthly,:note,:due_day)",
        [{**s, "due_day": s.get("due_day", "")} for s in SEED_SUBSCRIPTIONS],
    )
    await _db.executemany(
        "INSERT INTO debts(name,monthly,balance,rate,due_day) VALUES(:name,:monthly,:balance,:rate,:due_day)",
        [{**d, "due_day": d.get("due_day", "")} for d in SEED_DEBTS],
    )
    await _db.executemany(
        "INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)",
        list(SEED_SETTINGS.items()),
    )


async def _ensure_defaults() -> None:
    """对已有库补齐新增的设置默认键（版本化迁移）。"""
    conn = await _conn()
    await conn.executemany(
        "INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)",
        list(DEFAULT_SETTINGS.items()),
    )
    # 空库标记 data_note=empty：与示例库（seed）区分，前端据此不显示示例数据横幅
    if await _count("positions") == 0:
        await conn.execute(
            "INSERT INTO settings(key,value) VALUES('data_note','empty') "
            "ON CONFLICT(key) DO UPDATE SET value='empty'"
        )


async def _migrate_sessions_from_runs() -> None:
    """历史迁移：已有问答（旧库）按 thread 生成会话，标题取该线程首个问题。"""
    conn = await _conn()
    rows = await (
        await conn.execute(
            "SELECT r.thread_id, r.question FROM runs r"
            " WHERE r.id = (SELECT MIN(id) FROM runs WHERE thread_id = r.thread_id)"
            "   AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.thread_id = r.thread_id)"
        )
    ).fetchall()
    if not rows:
        return
    now = datetime.now().astimezone().isoformat(timespec="seconds")
    for r in rows:
        await conn.execute(
            "INSERT OR IGNORE INTO sessions(thread_id,title,created_at,updated_at)"
            " VALUES(?,?,?,?)",
            (r["thread_id"], str(r["question"])[:40] or "新会话", now, now),
        )


async def reset_to_seed() -> dict[str, Any]:
    """清空并重新种入示例数据（演示/测试用）。"""
    conn = await _conn()
    for t in (
        "positions",
        "transactions",
        "subscriptions",
        "debts",
        "settings",
        "budgets",
    ):
        await conn.execute(f"DELETE FROM {t}")
    await _seed_all()
    await conn.commit()
    return {"ok": True, "reset": True}


# --------------------------------------------------------------------------
# 读
# --------------------------------------------------------------------------


async def fetch_all(sql: str, params: tuple = ()) -> list[dict[str, Any]]:
    conn = await _conn()
    cur = await conn.execute(sql, params)
    rows = await cur.fetchall()
    return [dict(r) for r in rows]


async def list_positions() -> list[dict[str, Any]]:
    return await fetch_all("SELECT * FROM positions ORDER BY symbol")


async def list_transactions() -> list[dict[str, Any]]:
    return await fetch_all("SELECT * FROM transactions ORDER BY date DESC, id DESC")


async def list_subscriptions() -> list[dict[str, Any]]:
    return await fetch_all("SELECT * FROM subscriptions ORDER BY name")


async def list_debts() -> list[dict[str, Any]]:
    return await fetch_all("SELECT * FROM debts ORDER BY name")


async def get_settings() -> dict[str, str]:
    rows = await fetch_all("SELECT * FROM settings")
    return {r["key"]: r["value"] for r in rows}


# --------------------------------------------------------------------------
# 预算（budgets：month + category → amount；__total 为总预算）
# --------------------------------------------------------------------------


async def list_budgets(month: str) -> list[dict[str, Any]]:
    return await fetch_all(
        "SELECT month, category, amount FROM budgets WHERE month=? ORDER BY category",
        (month,),
    )


async def save_budgets(month: str, items: list[dict[str, Any]]) -> dict[str, Any]:
    """整月替换式保存：先删该月旧预算，再写入新列表。

    同月重复分类取最后一项（主键 (month,category) 不允许重复）；
    任一语句失败整体回滚，避免 DELETE 已执行而 INSERT 未完成的半截状态。
    """
    conn = await _conn()
    seen: dict[str, float] = {}
    for it in items:
        cat = str(it.get("category", "")).strip() or "__total"
        amt = float(it.get("amount", 0) or 0)
        if amt <= 0:
            continue
        seen[cat[:40]] = amt
    try:
        await conn.execute("DELETE FROM budgets WHERE month=?", (month,))
        for cat, amt in seen.items():
            await conn.execute(
                "INSERT INTO budgets(month,category,amount) VALUES(?,?,?)",
                (month, cat, amt),
            )
        await conn.commit()
    except Exception:  # aqg: top-level boundary — 事务失败统一回滚后原样抛出，不吞异常
        await conn.rollback()
        raise
    return {"ok": True, "month": month, "count": len(seen)}


async def month_expense_by_category(month: str) -> dict[str, float]:
    """当月支出按分类汇总（amount<0 视为支出，取绝对值）。"""
    rows = await fetch_all(
        "SELECT category, SUM(-amount) AS spent FROM transactions"
        " WHERE date LIKE ? AND amount < 0 GROUP BY category",
        (f"{month}%",),
    )
    return {r["category"]: float(r["spent"] or 0) for r in rows}


# --------------------------------------------------------------------------
# 写
# --------------------------------------------------------------------------


async def add_position(p: dict[str, Any]) -> dict[str, Any]:
    conn = await _conn()
    clean = {
        "symbol": str(p.get("symbol", "")).strip(),
        "name": str(p.get("name", "")).strip() or "未命名",
        "kind": str(p.get("kind", "股票")).strip() or "股票",
        "industry": str(p.get("industry", "其他")).strip() or "其他",
        "shares": float(p.get("shares", 0) or 0),
        "cost": float(p.get("cost", 0) or 0),
        "last": float(p.get("last", 0) or 0),
        "buy_date": (str(p.get("buy_date") or "").strip() or None),
        "fee": float(p.get("fee", 0) or 0),
    }
    if not clean["symbol"]:
        raise ValueError("代码不能为空")
    if clean["shares"] <= 0 or clean["shares"] != clean["shares"]:
        raise ValueError("股数需大于 0")
    if clean["cost"] < 0 or clean["cost"] != clean["cost"]:
        raise ValueError("成本价不能为负")
    if clean["last"] < 0 or clean["last"] != clean["last"]:
        raise ValueError("现价不能为负")
    if clean["fee"] < 0 or clean["fee"] != clean["fee"]:
        raise ValueError("费用不能为负")
    await conn.execute(
        "INSERT INTO positions(symbol,name,kind,industry,shares,cost,last,buy_date,fee)"
        " VALUES(:symbol,:name,:kind,:industry,:shares,:cost,:last,:buy_date,:fee)"
        " ON CONFLICT(symbol) DO UPDATE SET name=excluded.name, kind=excluded.kind,"
        " industry=excluded.industry, shares=excluded.shares, cost=excluded.cost,"
        " last=excluded.last, buy_date=excluded.buy_date, fee=excluded.fee",
        clean,
    )
    await _mark_user_data(conn)
    await conn.commit()
    return {"ok": True, "symbol": clean["symbol"]}


async def delete_position(symbol: str) -> dict[str, Any]:
    conn = await _conn()
    cur = await conn.execute("DELETE FROM positions WHERE symbol=?", (symbol,))
    await _mark_user_data(conn)
    await conn.commit()
    return {"ok": True, "deleted": cur.rowcount}


# --------------------------------------------------------------------------
# 自选行情（watchlist）
# --------------------------------------------------------------------------


async def list_watchlist() -> list[dict[str, Any]]:
    conn = await _conn()
    cur = await conn.execute("SELECT symbol,name,kind,created_at FROM watchlist ORDER BY created_at")
    rows = await cur.fetchall()
    return [
        {"symbol": r[0], "name": r[1], "kind": r[2], "created_at": r[3]}
        for r in rows
    ]


async def add_watchlist(symbol: str, name: str = "", kind: str = "股票") -> dict[str, Any]:
    sym = str(symbol).strip().upper()
    if not sym:
        raise ValueError("代码不能为空")
    import datetime as _dt

    conn = await _conn()
    await conn.execute(
        "INSERT INTO watchlist(symbol,name,kind,created_at) VALUES(?,?,?,?)"
        " ON CONFLICT(symbol) DO UPDATE SET name=excluded.name, kind=excluded.kind",
        (
            sym,
            str(name).strip()[:40] or sym,
            str(kind).strip()[:10] or "股票",
            _dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        ),
    )
    await _mark_user_data(conn)
    await conn.commit()
    return {"ok": True, "symbol": sym}


async def delete_watchlist(symbol: str) -> dict[str, Any]:
    conn = await _conn()
    cur = await conn.execute(
        "DELETE FROM watchlist WHERE symbol=?", (symbol.strip().upper(),)
    )
    await _mark_user_data(conn)
    await conn.commit()
    return {"ok": True, "deleted": cur.rowcount}


async def add_transaction(
    date: str, item: str, category: str, amount: float
) -> dict[str, Any]:
    """入账唯一入口：所有路径（手动 / 一句话记账 / CSV 导入）都必须经过这里。

    在此统一做真实日历校验与金额校验——`2026-13-99` 这类正则放行的
    脏日期会污染月度统计（趋势 / 预算 / 现金流），必须在写入前拦截。
    """
    import re as _re

    d = str(date).strip()
    amt = float(amount)
    if not _re.fullmatch(r"\d{4}-\d{2}-\d{2}", d):
        raise ValueError(f"日期需为 YYYY-MM-DD：{d!r}") from None
    try:
        datetime.strptime(d, "%Y-%m-%d")
    except ValueError:
        raise ValueError(f"日期不是有效日历日：{d!r}") from None
    if amt == 0 or amt != amt:  # NaN / 0 都拒绝
        raise ValueError("金额不能为 0 或 NaN")
    conn = await _conn()
    cur = await conn.execute(
        "INSERT INTO transactions(date,item,category,amount) VALUES(?,?,?,?)",
        (d, str(item).strip()[:80] or "未命名", str(category).strip()[:20] or "其他", amt),
    )
    await _mark_user_data(conn)
    await conn.commit()
    return {"ok": True, "id": cur.lastrowid}


async def delete_transaction(tx_id: int) -> dict[str, Any]:
    conn = await _conn()
    cur = await conn.execute("DELETE FROM transactions WHERE id=?", (int(tx_id),))
    await _mark_user_data(conn)
    await conn.commit()
    return {"ok": True, "deleted": cur.rowcount}


async def add_debt(d: dict[str, Any]) -> dict[str, Any]:
    conn = await _conn()
    clean = {
        "name": str(d.get("name", "")).strip(),
        "monthly": float(d.get("monthly", 0) or 0),
        "balance": float(d.get("balance", 0) or 0),
        "rate": float(d.get("rate", 0) or 0),
        "due_day": _clean_due_day(d.get("due_day", "")),
    }
    if not clean["name"]:
        raise ValueError("名称不能为空")
    await conn.execute(
        "INSERT INTO debts(name,monthly,balance,rate,due_day) VALUES(:name,:monthly,:balance,:rate,:due_day)"
        " ON CONFLICT(name) DO UPDATE SET monthly=excluded.monthly,"
        " balance=excluded.balance, rate=excluded.rate, due_day=excluded.due_day",
        clean,
    )
    await _mark_user_data(conn)
    await conn.commit()
    return {"ok": True, "name": clean["name"]}


async def delete_debt(name: str) -> dict[str, Any]:
    conn = await _conn()
    cur = await conn.execute("DELETE FROM debts WHERE name=?", (name,))
    await _mark_user_data(conn)
    await conn.commit()
    return {"ok": True, "deleted": cur.rowcount}


async def add_subscription(s: dict[str, Any]) -> dict[str, Any]:
    conn = await _conn()
    clean = {
        "name": str(s.get("name", "")).strip(),
        "monthly": float(s.get("monthly", 0) or 0),
        "note": str(s.get("note", "")).strip(),
        "due_day": _clean_due_day(s.get("due_day", "")),
    }
    if not clean["name"]:
        raise ValueError("名称不能为空")
    if clean["monthly"] <= 0:
        raise ValueError("月支出需大于 0")
    await conn.execute(
        "INSERT INTO subscriptions(name,monthly,note,due_day) VALUES(:name,:monthly,:note,:due_day)"
        " ON CONFLICT(name) DO UPDATE SET monthly=excluded.monthly,"
        " note=excluded.note, due_day=excluded.due_day",
        clean,
    )
    await _mark_user_data(conn)
    await conn.commit()
    return {"ok": True, "name": clean["name"]}


async def delete_subscription(name: str) -> dict[str, Any]:
    conn = await _conn()
    cur = await conn.execute("DELETE FROM subscriptions WHERE name=?", (name,))
    await _mark_user_data(conn)
    await conn.commit()
    return {"ok": True, "deleted": cur.rowcount}


# --------------------------------------------------------------------------
# 财务目标（goals）
# --------------------------------------------------------------------------


async def list_goals() -> list[dict[str, Any]]:
    return await fetch_all("SELECT * FROM goals ORDER BY created_at DESC, name")


async def add_goal(g: dict[str, Any]) -> dict[str, Any]:
    """新增目标。字段：name / target / saved（可选）/ deadline（可选，YYYY-MM）。"""
    name = str(g.get("name") or "").strip()[:40]
    if not name:
        raise ValueError("目标名称必填")
    try:
        target = float(g.get("target", 0) or 0)
    except (TypeError, ValueError):
        raise ValueError("目标金额不合法") from None
    if target <= 0:
        raise ValueError("目标金额需大于 0")
    try:
        saved = max(0.0, float(g.get("saved", 0) or 0))
    except (TypeError, ValueError):
        saved = 0.0
    deadline = str(g.get("deadline") or "").strip()[:7]
    conn = await _conn()
    await conn.execute(
        "INSERT INTO goals(name,target,saved,deadline,created_at)"
        " VALUES(?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET"
        " target=excluded.target, saved=excluded.saved, deadline=excluded.deadline",
        (name, target, saved, deadline, datetime.now().astimezone().isoformat(timespec="seconds")),
    )
    await _mark_user_data(conn)
    await conn.commit()
    return {"ok": True, "name": name, "target": target, "saved": saved, "deadline": deadline}


async def update_goal(name: str, patch: dict[str, Any]) -> dict[str, Any]:
    """更新目标的部分字段（target/saved/deadline）。"""
    name = str(name or "").strip()
    if not name:
        raise ValueError("目标名称必填")
    fields: list[str] = []
    params: list[Any] = []
    for key in ("target", "saved", "deadline"):
        if key not in patch:
            continue
        if key == "deadline":
            v = str(patch[key] or "").strip()[:7]
        else:
            try:
                v = float(patch[key])
            except (TypeError, ValueError):
                raise ValueError(f"{key} 不合法") from None
            if key == "target" and v <= 0:
                raise ValueError("目标金额需大于 0")
            if key == "saved":
                v = max(0.0, v)
        fields.append(f"{key}=?")
        params.append(v)
    if not fields:
        raise ValueError("没有可更新的字段")
    conn = await _conn()
    cur = await conn.execute(
        f"UPDATE goals SET {', '.join(fields)} WHERE name=?", [*params, name]
    )
    await _mark_user_data(conn)
    await conn.commit()
    if cur.rowcount == 0:
        raise ValueError("目标不存在")
    return {"ok": True, "name": name}


async def delete_goal(name: str) -> dict[str, Any]:
    conn = await _conn()
    cur = await conn.execute("DELETE FROM goals WHERE name=?", (name,))
    await _mark_user_data(conn)
    await conn.commit()
    return {"ok": True, "deleted": cur.rowcount}


# --------------------------------------------------------------------------
# 长期记忆（user_memory：agent 记住用户长期信息）
# --------------------------------------------------------------------------


async def list_memory() -> list[dict[str, Any]]:
    return await fetch_all("SELECT * FROM user_memory ORDER BY updated_at DESC, id DESC")


async def add_memory(content: str, kind: str = "fact") -> dict[str, Any]:
    """写入一条长期记忆；内容完全相同则只刷新时间戳（天然去重）。"""
    content = str(content or "").strip()
    if not content:
        raise ValueError("记忆内容不能为空")
    if len(content) > 500:
        content = content[:500]
    kind = str(kind or "fact").strip()[:20] or "fact"
    now = datetime.now().astimezone().isoformat(timespec="seconds")
    conn = await _conn()
    cur = await conn.execute(
        "SELECT id FROM user_memory WHERE content=? LIMIT 1", (content,)
    )
    row = await cur.fetchone()
    if row:
        await conn.execute(
            "UPDATE user_memory SET updated_at=?, kind=? WHERE id=?",
            (now, kind, row["id"]),
        )
        await conn.commit()
        return {"ok": True, "id": row["id"], "deduped": True}
    await conn.execute(
        "INSERT INTO user_memory(content,kind,created_at,updated_at) VALUES(?,?,?,?)",
        (content, kind, now, now),
    )
    await _mark_user_data(conn)
    await conn.commit()
    cur = await conn.execute("SELECT last_insert_rowid() AS id")
    row = await cur.fetchone()
    return {"ok": True, "id": row["id"]}


async def delete_memory(mem_id: int) -> dict[str, Any]:
    conn = await _conn()
    cur = await conn.execute("DELETE FROM user_memory WHERE id=?", (mem_id,))
    await _mark_user_data(conn)
    await conn.commit()
    return {"ok": True, "deleted": cur.rowcount}


async def clear_memory() -> dict[str, Any]:
    conn = await _conn()
    cur = await conn.execute("DELETE FROM user_memory")
    await _mark_user_data(conn)
    await conn.commit()
    return {"ok": True, "deleted": cur.rowcount}


async def set_setting(key: str, value: str) -> dict[str, Any]:
    conn = await _conn()
    await conn.execute(
        "INSERT INTO settings(key,value) VALUES(?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (str(key), str(value)),
    )
    await conn.commit()
    return {"ok": True}


async def _mark_user_data(conn: aiosqlite.Connection) -> None:
    await conn.execute(
        "INSERT INTO settings(key,value) VALUES('data_note','user') "
        "ON CONFLICT(key) DO UPDATE SET value='user'"
    )


# --------------------------------------------------------------------------
# 运行历史
# --------------------------------------------------------------------------


async def save_run(
    thread_id: str,
    question: str,
    answer: str,
    level: str,
    flags: list[dict[str, Any]] | None = None,
    route: str = "",
    llm: str = "",
    route_reason: str = "",
    tools: list[str] | None = None,
    actions: list[dict[str, Any]] | None = None,
    skip_session: bool = False,
) -> dict[str, Any]:
    conn = await _conn()
    created = datetime.now().astimezone().isoformat(timespec="seconds")
    cur = await conn.execute(
        "INSERT INTO runs(thread_id,question,answer,level,flags_json,created_at,route,llm,route_reason,tools,actions)"
        " VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        (
            thread_id or "default",
            question,
            answer,
            level or "",
            json.dumps(flags or [], ensure_ascii=False),
            created,
            route or "",
            llm or "",
            route_reason or "",
            json.dumps(tools or [], ensure_ascii=False),
            json.dumps(actions or [], ensure_ascii=False),
        ),
    )
    await conn.commit()
    if not skip_session:
        # 会话列表只收录真实对话；定时晨报等系统归档（thread_id='cron'）不建会话，
        # 晨报历史仍按 thread_id='cron' 从 runs 表读取，不污染「问AI」会话列表。
        await upsert_session(thread_id or "default", question)
    return {"ok": True, "id": cur.lastrowid}


async def delete_last_run(
    thread_id: str, question: str | None = None
) -> dict[str, Any]:
    """删除指定会话中某问题的最近一条问答（'重新生成'用：先移除旧回答再重答）。

    传 question 时精确匹配该问题的最近记录；未传或无匹配时退化为线程最后一条。
    """
    conn = await _conn()
    if question:
        cur = await conn.execute(
            "SELECT id FROM runs WHERE thread_id=? AND question=?"
            " ORDER BY id DESC LIMIT 1",
            (thread_id, question),
        )
        row = await cur.fetchone()
        if row:
            await conn.execute("DELETE FROM runs WHERE id=?", (row["id"],))
            await conn.commit()
            return {"ok": True, "deleted": 1}
    cur = await conn.execute(
        "SELECT id FROM runs WHERE thread_id=? ORDER BY id DESC LIMIT 1", (thread_id,)
    )
    row = await cur.fetchone()
    if row:
        await conn.execute("DELETE FROM runs WHERE id=?", (row["id"],))
        await conn.commit()
    return {"ok": True}


async def list_runs(
    thread_id: str | None = None, limit: int = 50
) -> list[dict[str, Any]]:
    if thread_id:
        rows = await fetch_all(
            "SELECT * FROM runs WHERE thread_id=? ORDER BY id DESC LIMIT ?",
            (thread_id, int(limit)),
        )
    else:
        rows = await fetch_all(
            "SELECT * FROM runs ORDER BY id DESC LIMIT ?", (int(limit),)
        )
    for r in rows:
        try:
            r["flags"] = json.loads(r.pop("flags_json") or "[]")
        except Exception:
            r["flags"] = []
        try:
            r["tools"] = json.loads(r.pop("tools") or "[]")
        except Exception:
            r["tools"] = []
        try:
            r["actions"] = json.loads(r.pop("actions") or "[]")
        except Exception:
            r["actions"] = []
    return rows


# --------------------------------------------------------------------------
# 会话管理（thread 列表：新建 / 重命名 / 删除）
# --------------------------------------------------------------------------


async def upsert_session(thread_id: str, title: str) -> dict[str, Any]:
    """问答落库时同步会话表：标题仍为默认'新会话'时用首个问题覆盖，否则保留自定义；刷新 updated_at。"""
    conn = await _conn()
    now = datetime.now().astimezone().isoformat(timespec="seconds")
    await conn.execute(
        "INSERT INTO sessions(thread_id,title,created_at,updated_at) VALUES(?,?,?,?)"
        " ON CONFLICT(thread_id) DO UPDATE SET"
        " title=CASE WHEN sessions.title='新会话' THEN excluded.title ELSE sessions.title END,"
        " updated_at=excluded.updated_at",
        (thread_id, title[:40] or "新会话", now, now),
    )
    await conn.commit()
    return {"ok": True, "thread_id": thread_id}


async def create_session(
    thread_id: str | None = None, title: str = "新会话"
) -> dict[str, Any]:
    conn = await _conn()
    tid = thread_id or uuid_hex()
    now = datetime.now().astimezone().isoformat(timespec="seconds")
    cur = await conn.execute(
        "INSERT INTO sessions(thread_id,title,created_at,updated_at) VALUES(?,?,?,?)",
        (tid, title[:40] or "新会话", now, now),
    )
    await conn.commit()
    return {"ok": True, "id": cur.lastrowid, "thread_id": tid}


async def list_sessions() -> list[dict[str, Any]]:
    rows = await fetch_all(
        "SELECT id, thread_id, title, created_at, updated_at"
        " FROM sessions ORDER BY updated_at DESC"
    )
    return rows


async def rename_session(session_id: int, title: str) -> dict[str, Any]:
    conn = await _conn()
    await conn.execute(
        "UPDATE sessions SET title=?, updated_at=? WHERE id=?",
        (
            str(title).strip()[:40] or "新会话",
            datetime.now().astimezone().isoformat(timespec="seconds"),
            int(session_id),
        ),
    )
    await conn.commit()
    return {"ok": True}


async def delete_session(session_id: int) -> dict[str, Any]:
    """删除会话及其全部问答记录。"""
    conn = await _conn()
    row = await (
        await conn.execute(
            "SELECT thread_id FROM sessions WHERE id=?", (int(session_id),)
        )
    ).fetchone()
    await conn.execute("DELETE FROM sessions WHERE id=?", (int(session_id),))
    if row:
        await conn.execute("DELETE FROM runs WHERE thread_id=?", (row["thread_id"],))
    await conn.commit()
    return {"ok": True, "deleted": True}


def uuid_hex() -> str:
    return uuid.uuid4().hex


# --------------------------------------------------------------------------
# 数据导出 / 月度趋势
# --------------------------------------------------------------------------


async def export_data() -> dict[str, Any]:
    """全量导出（备份）：持仓 / 流水 / 订阅 / 负债 / 预算 / 目标 / 长期记忆 / 设置 / 会话 / 问答。"""
    runs = await fetch_all("SELECT * FROM runs ORDER BY id")
    for r in runs:
        try:
            r["flags"] = json.loads(r.pop("flags_json") or "[]")
        except Exception:
            r["flags"] = []
        try:
            r["tools"] = json.loads(r.pop("tools") or "[]")
        except Exception:
            r["tools"] = []
    settings = await get_settings()
    # 备份文件可能被分享/上传：AI Key 不落明文（恢复时在设置页重新填写）
    if settings.get("ai_api_key"):
        settings["ai_api_key"] = "********"
    return {
        "version": 2,
        "exported_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "positions": await list_positions(),
        "transactions": await list_transactions(),
        "subscriptions": await list_subscriptions(),
        "debts": await list_debts(),
        "budgets": await fetch_all("SELECT * FROM budgets ORDER BY month, category"),
        "goals": await fetch_all("SELECT * FROM goals ORDER BY name"),
        "memory": await fetch_all("SELECT * FROM user_memory ORDER BY id"),
        "settings": settings,
        "sessions": await list_sessions(),
        "runs": runs,
    }


async def monthly_trend(months: int = 6) -> list[dict[str, Any]]:
    """按自然月聚合流水：收入 / 支出 / 结余（含当前月，最近 N 个月）。"""
    rows = await fetch_all(
        "SELECT substr(date,1,7) AS month,"
        " SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS income,"
        " SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) AS expense,"
        " SUM(amount) AS net"
        " FROM transactions GROUP BY month ORDER BY month DESC LIMIT ?",
        (int(months),),
    )
    return [dict(r) for r in reversed(rows)]


# --------------------------------------------------------------------------
# 备份恢复（导入导出配套；AI Key 不恢复，需重新在设置页填写）
# --------------------------------------------------------------------------


async def import_backup(data: dict[str, Any]) -> dict[str, int]:
    """把 export_data() 的 JSON 恢复进库：先清空业务表再写入。

    返回各表写入条数。settings 跳过 ai_api_key（安全），其余按 key 覆盖。
    """
    conn = await _conn()
    counts: dict[str, int] = {}
    try:
        for t in ("positions", "transactions", "subscriptions", "debts", "budgets", "goals", "user_memory", "runs", "sessions"):
            await conn.execute(f"DELETE FROM {t}")

        counts["positions"] = await _restore_table(
            conn, "positions", data.get("positions"),
            "INSERT INTO positions(symbol,name,kind,industry,shares,cost,last,buy_date,fee)"
            " VALUES(:symbol,:name,:kind,:industry,:shares,:cost,:last,:buy_date,:fee)",
        )
        counts["transactions"] = await _restore_table(
            conn, "transactions", data.get("transactions"),
            "INSERT INTO transactions(date,item,category,amount) VALUES(:date,:item,:category,:amount)",
        )
        counts["subscriptions"] = await _restore_table(
            conn, "subscriptions", data.get("subscriptions"),
            "INSERT INTO subscriptions(name,monthly,note,due_day) VALUES(:name,:monthly,:note,:due_day)",
        )
        counts["debts"] = await _restore_table(
            conn, "debts", data.get("debts"),
            "INSERT INTO debts(name,monthly,balance,rate,due_day) VALUES(:name,:monthly,:balance,:rate,:due_day)",
        )
        counts["budgets"] = await _restore_table(
            conn, "budgets", data.get("budgets"),
            "INSERT INTO budgets(month,category,amount) VALUES(:month,:category,:amount)",
        )
        counts["goals"] = await _restore_table(
            conn, "goals", data.get("goals"),
            "INSERT INTO goals(name,target,saved,deadline,created_at)"
            " VALUES(:name,:target,:saved,:deadline,:created_at)",
        )
        counts["memory"] = await _restore_table(
            conn, "user_memory", data.get("memory"),
            "INSERT INTO user_memory(content,kind,created_at,updated_at)"
            " VALUES(:content,:kind,:created_at,:updated_at)",
        )

        # 设置：整表覆盖，但 AI Key 永不恢复（明文 Key 不进备份/恢复链路）
        settings = (data.get("settings") or {})
        if isinstance(settings, dict):
            await conn.execute("DELETE FROM settings")
            await conn.executemany(
                "INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)",
                [(k, str(v)) for k, v in settings.items() if k != "ai_api_key"],
            )
            await _ensure_defaults()
            await _mark_user_data(conn)
            counts["settings"] = len(settings) - (1 if "ai_api_key" in settings else 0)

        # 会话与问答历史：整体恢复（tools/flags 原样保留）
        sessions = data.get("sessions") or []
        for s in sessions:
            if not isinstance(s, dict) or not s.get("thread_id"):
                continue
            await conn.execute(
                "INSERT OR IGNORE INTO sessions(thread_id,title,created_at,updated_at)"
                " VALUES(?,?,?,?)",
                (s["thread_id"], str(s.get("title") or "新会话")[:40], s.get("created_at") or "", s.get("updated_at") or ""),
            )
        counts["sessions"] = len(sessions)
        runs = data.get("runs") or []
        for r in runs:
            if not isinstance(r, dict) or not r.get("question"):
                continue
            await conn.execute(
                "INSERT INTO runs(thread_id,question,answer,level,flags_json,created_at,route,llm,route_reason,tools)"
                " VALUES(?,?,?,?,?,?,?,?,?,?)",
                (
                    r.get("thread_id") or "default",
                    str(r.get("question") or "")[:500],
                    str(r.get("answer") or ""),
                    str(r.get("level") or ""),
                    json.dumps(r.get("flags") or [], ensure_ascii=False),
                    r.get("created_at") or datetime.now().astimezone().isoformat(timespec="seconds"),
                    str(r.get("route") or ""),
                    str(r.get("llm") or ""),
                    str(r.get("route_reason") or ""),
                    json.dumps(r.get("tools") or [], ensure_ascii=False),
                ),
            )
        counts["runs"] = len(runs)

        await conn.commit()
    except Exception:  # noqa: BLE001 — 恢复失败整体回滚，不留半截状态
        await conn.rollback()
        raise
    return counts


async def _restore_table(
    conn: aiosqlite.Connection,
    name: str,
    rows: Any,
    sql: str,
) -> int:
    """把备份列表写回指定表；坏行跳过不影响整体。"""
    if not isinstance(rows, list):
        return 0
    n = 0
    for row in rows:
        if not isinstance(row, dict):
            continue
        try:
            await conn.execute(sql, row)
            n += 1
        except Exception:  # noqa: BLE001 — 单行失败跳过
            continue
    return n
