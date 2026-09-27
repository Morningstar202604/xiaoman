import sys
from pathlib import Path

import pytest

_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))


@pytest.fixture
async def temp_db(tmp_path, monkeypatch):
    """临时内存库（test_api.py 自带同语义本地 fixture，此处供其余测试文件复用）。"""
    from app import db

    monkeypatch.setattr(db, "DB_PATH", tmp_path / "wealth.db")
    await db.init_db()
    yield
    await db.close_db()
