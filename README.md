# 小满 · 慢慢存，小满即富

**小满**——二十四节气里谷物渐满未满的时节。理财同理：不求一夜暴富，每天攒一点，日子自有分寸地饱满起来。

- **Slogan**：慢慢存，小满即富 · **交互口号**：记一笔，问一句
- **定位**：本地运行 × 云端能力——程序与数据全部跑在你自己电脑上（SQLite），AI 问答与实时行情走云端 API；国内平台与国产模型优先（DeepSeek / 豆包 / 通义千问预设），不依赖国外服务
- **技术栈**：FastAPI + LangGraph · React 19 + Vite + Tailwind 4 · SQLite（本地优先）· 东方财富→新浪→快照三级行情降级 · PWA

## 功能总览（5 页签）

| 页签 | 内容 |
|---|---|
| **总览** | 指数行情条 · 资产四卡（总资产/今日盈亏/持仓市值/可用现金）· 资产分布 · Top 持仓 · 预算进度（超支预警）· 提醒条（预算超支/目标临期/待扣款跨月不漏）· 风控横幅 · 财务体检入口 · 无数据时引导记账 |
| **持仓** | 股票/基金/理财/现金分组 · 集中度与行业风控卡 · 逐笔盈亏（红涨绿跌）· 点标的看 K 线 |
| **行情** | 自选列表（带实时价与涨跌、可增删）· 持仓行情 · 搜索（东财 suggest）· 单股 K 线弹层 · 行情来源与免责脚注 |
| **记账** | 一句话记账（规则秒回入账，疑问句不误记）· 账单 CSV 导入 · 流水搜索 · 手工录入 · 负债/订阅/目标管理（5 页签下唯一账户管理入口） |
| **问AI** | 常驻快捷指令 chips · 真流式 SSE · agent 工具循环（调用过程实时展示、失败自动降级确定性分析）· 多会话 · 重新生成 · 对话内一句话记账/长期记忆 · 每日晨报（L1 洞察/L2 建议徽标）· 每条回答标注来源徽标 |

**一条完整工作流**：用户一句话（如「看看贵州茅台，合适就加自选」→「买了 100 股成本 1500」）由模型编排 `search_symbol → get_quote → get_kline → add_to_watchlist → record_position`，从找标的到落库全自动，行情页自选、总览与持仓页即时可见。所有数字来自确定性内核或真实行情源，绝不编造。

## 快速开始

环境要求：Python 3.10+；Node.js 20.19+ / 22.12+。

```bash
# 后端（依赖见 backend/requirements.txt；必须在 backend 目录内启动）
cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env          # 可选：填 LLM_* 启用模型（默认国产端点见 .env.example 注释）
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8787

# 前端：开发模式（热更新，/api 反代到 8787）
cd frontend
npm install && npm run dev    # http://127.0.0.1:5199

# 前端：生产模式（构建后由后端单端口托管）
cd frontend && npm run build  # 然后访问 http://127.0.0.1:8787
```

一键启动（根目录执行）：`scripts/dev.sh`（后端 8787 + 前端 dev 5199）。Docker 部署：`docker compose up -d --build`（单容器同端口 8787，数据卷 `xiaoman-data`）。

- 首次运行自动种入一套示例数据（相对当前日期生成）；顶部横幅明示「示例数据」，可随时在记账页替换或恢复示例。
- **AI 可选**：设置页填任一 OpenAI 兼容端点即生效；未配置或调用失败自动回退内置确定性分析（带来源徽标）。
- **备份**：设置页可全量导出/恢复；**推荐设置备份口令**——带口令导出为加密包（PBKDF2+Fernet），口令不落盘、忘记无法找回；无口令导出为明文（导出前有强提示）。

## 架构

```
前端（React 5 页签：总览/持仓/行情/记账/问AI）
  → FastAPI：REST + SSE + 静态托管 + 最小鉴权（API_TOKEN）
  → LangGraph 多智能体编排图（agent_graph.py）：supervisor 分类 → record/memory/general
      或 collect_market → collect_ledger → risk → finalize（顺序边，适配单连接 SQLite）
  → 确定性分析内核（analysis.py）：所有数字的唯一计算源
  → agent 工具层（agent.py + tools.py）：function calling 多轮工具循环，17 个工具——
      get_market_view / get_ledger_view / get_risk_flags / get_budget / get_trend /
      record_transaction / get_kline / get_goals / get_user_memory / save_user_memory /
      get_health_check / search_symbol / get_quote / add_to_watchlist /
      remove_from_watchlist / get_watchlist / record_position
  → LLM 接入（llm.py，OpenAI 兼容，DeepSeek/豆包/通义预设）
  → 数据层：SQLite（aiosqlite + WAL）：持仓/流水/负债/订阅/预算/设置/目标/长期记忆/自选/问答历史
  → 外部：行情三级降级 东财 → 新浪 → 组合库快照（快照价标注离线估值）
```

框架管编排、内核管算数：模型只出现在分类与成文两步，任一失败自动降级确定性路径（服务不中断、不冒充模型结果）。langchain-openai 不引入，避免版本耦合。

## 目录

```
backend/app/
  main.py       FastAPI：REST + SSE + 鉴权 + 静态托管 + 备份恢复/K线/CSV导出
  db.py         数据层：schema + 增量迁移 + 全部表读写
  analysis.py   确定性分析内核：持仓/现金流/负债/应急金/集中度/风控/模板叙述
  quotes.py     行情层：东财→新浪→快照三级降级 + 统一缓存注册表（_ALL_CACHES）
  llm.py        模型接入：OpenAI 兼容端点，流式/JSON
  nlparse.py    一句话记账：规则引擎 + AI 兜底
  csvimport.py  账单 CSV：列映射与分类识别
  tools.py      agent 工具层：17 个 function calling 工具（schema + 执行体 + 截断）
  agent.py      agent 工具循环：LLM function calling 多轮循环（编排见 agent_graph）
  agent_graph.py LangGraph 编排图：supervisor + 专门节点 + 条件路由（主执行路径）
  service.py    问答服务：路由分类/纯函数/事件契约（数字仍由确定性内核计算）
  scheduler.py  定时晨报：APScheduler（cron 即改即生效）
  backup.py     本地加密备份：PBKDF2+Fernet，口令不落盘
frontend/src/
  App.tsx               5 页签布局（桌面顶栏/移动底栏）
  components/Dashboard.tsx      总览（指数条/资产卡/预算/提醒条/风控/体检）
  components/HoldingsView.tsx   持仓（分组/集中度/行业风控）
  components/MarketView.tsx     行情（自选+持仓双 Tab、搜索、来源脚注）
  components/EntryView.tsx      记账（一句话记账/CSV/流水/负债/订阅/目标）
  components/ChatView.tsx       问AI（流式/工具过程/chips/晨报/会话）
  components/IndicesStrip.tsx / KlineDialog.tsx / MorningReportDialog.tsx / PositionsTable.tsx / TopBar.tsx / SessionSidebar.tsx / SettingsView.tsx / GoalsPanel.tsx / SummaryBlock.tsx / HealthCheckDialog.tsx
  lib/               api / store / i18n（zh+en）/ charts（ECharts 懒加载）/ format / brand
backend/data/   （gitignore）wealth.db：全部个人数据
```

## API

| 端点 | 说明 |
|---|---|
| `GET /api/dashboard` | 总览全量数据（持仓/账本/负债/预算/风控/指数/今日盈亏/来源，一次拉取） |
| `POST /api/ask` | SSE 流式问答（start/step/agent_step/text/final/done） |
| `GET /api/watchlist` · `POST/DELETE /api/watchlist` | 自选：列表（带实时价与来源）/ 增 / 删 |
| `GET /api/quote` · `GET /api/search` · `GET /api/kline` | 单股实时价 / 搜索（东财 suggest）/ K 线 |
| `POST /api/nl-add` | 一句话记账（规则秒回 / AI 兜底，返回 `source: rule\|ai`） |
| `GET/PUT /api/budgets` · `POST/DELETE /api/debts` · `POST/DELETE /api/subscriptions` | 预算 / 负债 / 订阅 |
| `GET/POST/PUT/DELETE /api/goals` · `GET/POST/DELETE /api/memory` | 目标 / 长期记忆 |
| `GET /api/health-check` | 五维财务体检 |
| `GET /api/export?passphrase=` · `POST /api/import/backup` | 全量备份（带口令加密）/ 恢复（检测加密则校验口令） |
| `GET /api/export/csv` · `POST /api/import/csv` · `POST /api/import/commit` | 流水 CSV 导出 / 账单导入 |
| `GET /api/reports` · `POST /api/reports/generate` · `GET /api/scheduler` | 晨报历史 / 生成 / 调度状态 |
| `GET /api/bootstrap` · `GET/PUT /api/settings` · `GET /api/health` | 引导数据 / 设置 / 健康检查 |

**鉴权**：设 `API_TOKEN` 后 `/api/*` 需 `Bearer` 或 `?token=`；未设口令时 Host/Origin 防护仅放行本机与 `ALLOWED_HOSTS` 白名单。

## 测试与检查

```bash
cd backend && .venv/bin/python -m pytest tests -q    # 179 项：分析内核/行情三级降级/agent 工具循环/LangGraph 图/API 集成/备份加密往返/目标/记忆/体检/密钥扫描
cd backend && .venv/bin/python -m ruff check app tests
cd frontend && npm run build                          # tsc + vite build（自动 bump SW 缓存版本）
```

## 数据与隐私

- 所有个人数据只存本机 SQLite；行情走东财/新浪公开接口；模型调用仅在你配置的端点发生。
- 备份推荐带口令加密导出；明文导出会强提示。行情全失败时用组合库快照价，界面标注「离线估值，非实时」。

## 免责声明

本软件输出的全部内容（财务体检、每日晨报、AI 顾问回答、目标与预算建议）**仅供参考，不构成投资建议**，不构成任何收益承诺。市场有风险，投资需谨慎，据此操作风险自担。

## 开源

- 协议：[MIT](LICENSE)；行为准则：[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) · 贡献指引：[CONTRIBUTING.md](CONTRIBUTING.md) · 安全说明：[SECURITY.md](SECURITY.md)
- CI 覆盖后端 ruff + pytest 与前端 tsc + build。

## 更新日志

- **2026-09（投资者心智重构 + 工作流贯通）**：5 页签导航（总览/持仓/行情/记账/问AI，默认总览）；指数行情条；持仓页（分组+集中度风控）；行情页（自选+持仓双 Tab、搜索、K 线）；红涨绿跌；AI 工具扩至 17 个（行情/自选/持仓录入），一句话工作流贯通（搜→看→加自选→记录买入→页面可见）；快捷指令 chips；总览提醒条（预算超支/目标临期/待扣款）；流水按日分组；晨报 L1/L2 徽标；本地加密备份（PBKDF2+Fernet）；行情三级降级（东财→新浪→快照）；拆解清理（删重复入口/死 i18n/无关脚本，合并冗余请求）。
- **2026-09（目标 · 记忆 · 体检）**：财务目标、长期记忆、五维财务体检；对话内「记住…」记忆指令。
- **2026-09（LangGraph 单路径化）**：移除旧顺序流程双轨，LangGraph 图成为唯一执行路径；React 19/Vite 7/Tailwind 4 现代化。
- **2026-09（agent 升级）**：真 agent 工具循环、订阅增删、K 线、备份恢复、口令框、Docker、一键启动。
- **2026-09**：预算、一句话记账、CSV 导入、待扣提醒、PWA、会话搜索、重新生成、AI 问答、品牌系统。
