# 随身理财 · 你的随身财务管家

一个**对话优先（chat-first）**的个人财务助手：先当通用问答助手打开，有数据后再叠加组合持仓 / 风控规则引擎的确定性分析（未接入模型时内置分析兜底）+ PWA 移动端。
数据全部存在本地 SQLite，行情走东方财富（失败自动降级快照），模型走国内 OpenAI 兼容端点，不依赖国外服务。

> 设计原则：**确定性内核优先**（数字全部由规则引擎计算，可靠免费秒级）；**不重复造轮子**
> （不装 LangGraph / LangChain / MCP / assistant-ui 等重型框架，FastAPI + aiosqlite + APScheduler + ECharts 直接解决问题）；
> **交互符合人的习惯**（打开先看到输入框而不是一屏数字，一句话记账，问答直接出答案，工程细节不进用户界面）。

---

## ✨ 功能总览

| 入口 | 内容 |
|---|---|
| **仪表盘** | 总市值 / 累计盈亏 / 本月结余 / 储蓄率、资产分布与支出结构图表、近 6 个月收支趋势、**本月预算进度（超支预警，投资/还款不计入支出）**、**待扣提醒（还款/订阅扣款日，跨月不漏）**、应急金进度、负债与订阅（含扣款日）、持仓明细（红涨绿跌、可排序）、风险提示横幅；大金额缩写（明细图表按需展开加载）；**无数据时不显示零值卡与风险横幅，改为「去记账」引导** |
| **记账** | **一句话记账**（「昨天打车 32 元」规则秒回入账，复杂句自动升级 AI 补分类）、**账单 CSV 导入**（微信/支付宝/银行格式自动识别列与分类，预览后批量入账）、手工录入/删除持仓、流水、负债（含每月还款日） |
| **问答（默认首屏）** | 多会话管理（新建 / 重命名 / 删除 / 搜索）、真流式 SSE、**回答重新生成**、语音提问、导出（复制 / 下载 Markdown）、按当前数据生成追问建议、**无数据时切换为通用助手话术与引导建议**、**对话内一句话记账**（短句如「午饭 35 元」直接入账并回执，规则解析不依赖模型；疑问句不会被误记）、**多轮追问**（已接入模型时，「那上个月呢？」这类省略追问会带上本会话最近 4 轮上下文；未接入模型时不改判，避免用「本月」数据冒充上月）、可展开"分析过程"、**通用问答路由**（不含财务关键词的问题走通用助手，**不外发你的财务数据与财务历史**、不挂财务免责声明）、**AI 优先**（接入任意 OpenAI 兼容模型：豆包 / DeepSeek / 通义 / Agnes 等，失败自动降级内置分析），**每条回答标注来源徽标（AI 生成 / 内置分析），未接入时页内引导接入** |
| **每日晨报** | APScheduler 定时生成（cron 即改即生效），设置页可查看最近晨报历史；**空库不生成**（无数据时点击会提示"还没有数据"，不产出无意义晨报） |
| **预算** | 月度总预算 + 分类预算，仪表盘实时展示进度、剩余日均、超支预警（<80% 绿 / ≥80% 黄 / 超支红） |
| **设置** | 偏好（浅色 / 深色 / 跟随系统、语音提问）、账本规则（月收入 / 应急金目标 / 必要支出类别 / 储蓄率目标）、预算、AI 回答、每日晨报（历史）、数据与状态（恢复示例 / 全量 JSON 导出）、访问口令 |
| **PWA** | 可安装、离线壳加载、断网数据降级提示、图标/主题色/manifest 完整 |

## 📸 界面预览

| | | |
|---|---|---|
| ![仪表盘](docs/preview/23-budget-dashboard.png) | ![一句话记账](docs/preview/25-nl-ledger.png) | ![CSV 导入](docs/preview/26-import-preview.png) |
| 仪表盘（预算 + 待扣提醒） | 一句话记账 | 账单 CSV 导入 |
| ![待扣提醒](docs/preview/27-due-reminder.png) | ![AI 设置](docs/preview/22-ai-settings.png) | ![PWA 离线](docs/preview/21-pwa-offline-v2.png) |
| 本月待扣提醒 | AI 回答配置 | PWA 离线壳 |

## 🚀 快速开始

```bash
# 后端（依赖见 backend/requirements.txt）
cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env          # 可选：填 LLM_* 启用模型，填 API_TOKEN 启用访问口令
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8787

# 前端：开发模式（热更新，/api 反代到 8787）
cd frontend
npm install && npm run dev    # http://127.0.0.1:5199

# 前端：生产模式（构建后由后端单端口托管）
cd frontend && npm run build
# 然后访问 http://127.0.0.1:8787
```

首次运行自动种入一套示例数据（相对当前日期生成，保证"本月"口径可看），仪表盘顶部会常驻横幅明说「当前显示的是示例数据，不是你的真实账本」并给出「记我的第一笔」入口；可在「记账」页替换成自己的真实数据。**老库即使用户清空了持仓也绝不重新播种**，清空后总览降级为引导卡，不会拿示例数据糊弄你。
**AI 优先，未接入有引导**：默认启用 AI 回答，在「设置 → AI 回答」里填入任一 OpenAI 兼容端点（Base URL / Key / 模型）即生效，Key 仅存本机数据库；三要素未配或调用失败自动回退内置确定性分析（回答带来源徽标，问答页显示接入引导条）。
**问答是通用助手，财务是增强层**：不含财务关键词的问题走通用问答（`route=general`），此时**不向模型发送任何持仓/账本数据**、回答不挂财务免责声明；命中财务关键词才走确定性分析。空库时问财务问题得到的是录入引导，不是"总市值 0 元"式的零值报告。

## 🏗 架构

```
用户端（手机优先）→ 前端 Vite + React（仪表盘 ECharts / 问答 / 记账 / 设置 / PWA；framer-motion 页面转场 + Radix Tooltip/确认框）
  → FastAPI：REST + SSE + 静态托管 + 最小鉴权（API_TOKEN）
  → 应用层：确定性分析内核（analysis.py）+ 可选 LLM 增强（llm.py，httpx 直连国内模型）
             + 自然语言记账（nlparse.py：规则秒回 + AI 兜底）
             + 账单导入（csvimport.py：列映射 + 分类识别）
  → 数据层：SQLite（aiosqlite + WAL）持仓/流水/负债/订阅/预算/设置/问答历史
  → 外部：东方财富行情（异步、超时、失败降级快照）
```

问答流程（`service.py`，普通异步顺序，无图编排）：规则分类意图 → 并行取数分析（市场/账本视角）
→ 风控规则复核 → 成文（LLM 流式或模板）。

## 📁 目录

```
backend/app/
  db.py        数据层：aiosqlite 单连接 + WAL；schema + 增量迁移；预算/会话等
  analysis.py  确定性分析内核：持仓/现金流/负债/应急金/集中度/风控规则 + 模板叙述
  quotes.py    行情层：东财 push2 异步批量行情（免 key）+ 快照降级 + 缓存
  llm.py       模型接入：httpx 直连任意 OpenAI 兼容端点，流式问答 + 非流式 JSON 解析
  nlparse.py   一句话记账：规则引擎（金额/日期/收支/分类）+ AI 兜底
  csvimport.py 账单 CSV：解析、表头列映射、收支与分类识别
  service.py   问答服务：意图规则分类 → 并行取数 → 风控复核 → 流式成文 → 归档
  scheduler.py 定时晨报：APScheduler（cron，设置即改即生效）
  main.py      FastAPI：REST + SSE + 鉴权中间件 + 静态托管
frontend/src/
  App.tsx              布局：移动端底部导航 / 桌面端顶部导航
  components/Dashboard.tsx    仪表盘（统计卡 + ECharts + 预算/待扣提醒 + 风控 + 持仓表）
  components/ChatView.tsx     问答（真流式、重新生成、建议 chips、分析过程折叠、语音）
  components/EntryView.tsx    记账（一句话记账 / CSV 导入 / 持仓/流水/负债增删）
  components/SettingsView.tsx 设置（分界面导航：偏好/账本规则/预算/AI 回答/晨报/数据与状态/口令）
  lib/api.ts           请求封装（口令自动附带、401 引导输入）
  lib/store.ts         极简全局状态
  lib/charts.ts        ECharts 按需注册 + 运行时懒加载（不进首屏包）
frontend/tests/
  ui-checks.mjs        UI 断言单入口（64 项：chat-first 首屏/空数据降级/结构/懒加载/新组件/AI接入与来源/待扣跨月/应急金态）
  ui-visual.mjs        四页宽度与溢出量化审查（输出报告，不判定）
  _harness.mjs         playwright 解析兜底 + 浏览器启动 + 断言收集
docs/preview/          各版本实测截图
backend/data/          （gitignore）wealth.db：所有个人数据（组合/账本/预算/设置/问答历史）
```

## 🔌 API

| 端点 | 说明 |
|---|---|
| `GET /api/health` | 健康检查（免鉴权） |
| `GET /api/bootstrap` | 设置 + 调度状态 + 模型配置 + 数据来源 |
| `GET /api/dashboard` | 仪表盘全量数据（持仓/账本/负债/预算/风控/来源，一次拉取） |
| `POST /api/positions` · `DELETE /api/positions/{symbol}` | 增/删持仓 |
| `POST /api/transactions` · `DELETE /api/transactions/{id}` | 增/删流水 |
| `POST /api/nl-add` | 一句话记账（规则秒回 / AI 兜底，返回 `source: rule\|ai`） |
| `POST /api/import/csv` · `POST /api/import/commit` | 账单 CSV：解析预览 / 批量入账 |
| `GET /api/budgets` · `PUT /api/budgets` | 预算：读取本月设置与实时使用率 / 保存（总预算 `__total` + 分类） |
| `POST /api/debts` · `DELETE /api/debts/{name}` | 增/删负债（含每月还款日 due_day） |
| `GET /api/settings` · `PUT /api/settings` | 读/写设置（校验 + 部分更新 + AI 配置即改即生效） |
| `POST /api/ask` | SSE 流式问答（事件：start/step/text/final/done；支持 regenerate 替换回答） |
| `GET /api/history` · `POST /api/export` | 问答历史 / 全量 JSON 备份（version 2） |
| `POST /api/reports/generate` · `GET /api/reports` | 手动生成 / 查看晨报 |
| `POST /api/portfolio/reset` | 恢复示例数据 |

**鉴权**：设置 `API_TOKEN` 后，所有 `/api/*`（除 health）需带 `Authorization: Bearer <口令>`
或查询参数 `?token=<口令>`；前端首次遇到 401 会提示输入口令并记住。未设置口令时启用 Host/Origin 防护：仅放行本机地址与 `ALLOWED_HOSTS` 白名单（防 DNS rebinding 与跨站读取），`/api/health` 恒免检。

## 🧪 测试与检查

```bash
cd backend && .venv/bin/python -m pytest tests -q   # 98 项：分析内核/行情/API 集成（预算/NL记账/CSV导入/应急金误报/通用路由/对话内记账/多轮上下文/空数据路径/Host防护等）
cd backend && .venv/bin/python -m ruff check app tests
cd frontend && npm run build                        # tsc + vite build（自动 bump SW 缓存版本）
node frontend/tests/ui-checks.mjs                   # 64 项 UI 断言（需后端已在 8787 运行；依赖 playwright）
```

## 🔒 数据与隐私

- 所有个人数据（持仓、流水、负债、预算、设置、问答历史、AI Key）**只存本机 SQLite**（`backend/data/wealth.db`，已 gitignore，不会进入仓库）。
- 行情走东方财富公开接口（免 key）；模型调用仅在你配置的 OpenAI 兼容端点发生。
- 恢复示例数据 / 全量导出（JSON 备份）在「设置 → 数据与状态」。

## 🤝 开源

- 协议：[MIT](LICENSE)
- 行为准则：[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) · 贡献指引：[CONTRIBUTING.md](CONTRIBUTING.md) · 安全说明：[SECURITY.md](SECURITY.md)
- Issue / PR 模板已内置（`.github/`），CI 覆盖后端 ruff + pytest 与前端构建。

## 📄 更新日志

- **2026-09**：预算管理、一句话记账、账单 CSV 导入、还款/订阅扣款日提醒、PWA、会话搜索、回答重新生成、AI 问答接入、品牌系统（四套主题）、移动端适配、全量审查修复 29 项。
