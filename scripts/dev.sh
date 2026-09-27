#!/usr/bin/env bash
# 随身理财 · 一键开发启动（后端 8787 + 前端 dev 5199，Ctrl-C 一起退出）
# 用法：scripts/dev.sh    （在仓库根目录执行；会按需创建 venv / 安装依赖）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"

command -v python3 >/dev/null 2>&1 || { echo "✗ 缺少 python3（需 3.9+，建议 3.12）"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "✗ 缺少 node（需 18+）"; exit 1; }

# 后端：venv + 依赖
if [ ! -x "$BACKEND/.venv/bin/python" ]; then
  echo "== 创建后端虚拟环境 =="
  python3 -m venv "$BACKEND/.venv"
fi
if ! "$BACKEND/.venv/bin/python" -c "import fastapi, uvicorn, aiosqlite" >/dev/null 2>&1; then
  echo "== 安装后端依赖 =="
  "$BACKEND/.venv/bin/pip" install -q -r "$BACKEND/requirements.txt"
fi

# 前端：依赖
if [ ! -d "$FRONTEND/node_modules" ]; then
  echo "== 安装前端依赖 =="
  (cd "$FRONTEND" && npm install --no-audit --no-fund)
fi

cleanup() { kill 0 2>/dev/null || true; }
trap cleanup EXIT INT TERM

echo "== 启动后端 http://127.0.0.1:8787 =="
(cd "$BACKEND" && .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8787) &
echo "== 启动前端 dev http://127.0.0.1:5199 =="
(cd "$FRONTEND" && npm run dev) &
wait
