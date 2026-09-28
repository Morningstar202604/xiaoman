# 小满 · 慢慢存，小满即富

## 🌾 品牌

**小满**——二十四节气里谷物渐满未满的时节。理财同理：不求一夜暴富，每天攒一点，
日子自有分寸地饱满起来。

- **中文名**：小满（Xiaoman）｜**英文名**：Xiaoman
- **Slogan**：慢慢存，小满即富
- **交互口号**：记一笔，问一句
- **视觉**：麦穗金主色 + 宣纸暖白底 + 墨色正文（深色为墨夜纸），Logo 为一颗渐满的麦粒与上扬的积累弧线

---

一个**对话优先（chat-first）**的个人财务助手：先当通用问答助手打开，有数据后再叠加组合持仓 / 风控规则引擎的确定性分析（未接入模型时内置分析兜底）+ PWA 移动端。
数据全部存在本地 SQLite，行情走东方财富（失败自动降级快照），模型走国内 OpenAI 兼容端点，不依赖国外服务。

---

## 🌾 Brand

**Xiaoman（小满）** — named after the 24-solar-term *Grain Buds*, when grain fills but is not yet full.
Saving works the same way: build steadily, and wealth arrives in its own measure.

- **Name**: 小满 (Xiaoman) ｜ English: Xiaoman
- **Slogan**: 慢慢存，小满即富 — *Save steadily, prosper in full*
- **Tagline**: 记一笔，问一句 — *Log one line, ask one line*
- **Language**: English-first UI with one-click Chinese switch (answers follow the UI language)
- **Stack**: LangGraph multi-agent orchestration · FastAPI · React 19 + Vite + Tailwind · SQLite (local-first) · Eastmoney quotes (auto fallback to snapshot) · PWA

A **chat-first personal finance agent**: open it and start typing; record a transaction in one sentence
("lunch 35 yuan"), ask about your portfolio, run a 5-dimension health check, track goals and get a
daily brief — every number comes from a deterministic local engine, and the LangGraph state graph
routes supervision / market / ledger / risk / memory / record / finalize agents (LLM optional, graceful
fallback to built-in analysis when no model is connected).

> 设计原则：**确定性内核优先**（数字全部由规则引擎计算，可靠免费秒级）；**编排交给主流 agent 框架**
> （LangGraph 多智能体状态图：supervisor 分类 + 市场/账本/风控/记账/成文专门 agent 节点，
> 图负责编排与状态流转，模型只出现在分类与成文两步，任一失败自动降级确定性路径）；
> **交互符合人的习惯**（打开先看到输入框而不是一屏数字，一句话记账，问答直接出答案，工程细节不进用户界面）。

---

## ✨ 功能总览

| 入口 | 内容 |
|---|---|
| **仪表盘** | 总市值 / 累计盈亏 / 本月结余 / 储蓄率、资产分布与支出结构图表、近 6 个月收支趋势、**本月预算进度（超支预警，投资/还款不计入支出）**、**待扣提醒（还款/订阅扣款日，跨月不漏）**、应急金进度、负债与订阅（含扣款日）、**持仓明细（红涨绿跌、可排序，点标的查看 K 线走势）**、风险提示横幅、**财务目标进度卡（目标 / 已存 / 百分比 / 建议月存）+「财务体检」入口（五维评分弹层）**；大金额缩写（明细图表按需展开加载）；**无数据时不显示零值卡与风险横幅，改为「去记账」引导** |
| **记账** | **一句话记账**（「昨天打车 32 元」规则秒回入账，复杂句自动升级 AI 补分类）、**账单 CSV 导入**（微信/支付宝/银行格式自动识别列与分类，预览后批量入账）、**流水搜索**（名称/分类/日期本地即时过滤）、手工录入/删除持仓、流水、负债（含每月还款日）、**订阅（可增删，含扣款日，纳入结余与待扣提醒）**、**财务目标（增删改：目标金额 / 已存 / 截止月份，进度条 + 建议月存 + 快捷 +1k/-1k）** |
| **问答（默认首屏 = 通用 agent）** | **默认路径是通用助手**：不带财务分级、不显示分析过程、**记得同一会话的上文**（追问「再短一点」它知道你在说什么），且**通用对话不带任何财务数据出机**；财务问答是其中一条能力，命中财务关键词才走确定性分析（持仓/收支/风险，回答带等级与关键数字）。另有：多会话管理（新建 / 重命名 / 删除 / 搜索）、真流式 SSE、**回答重新生成**、语音提问、导出（复制 / 下载 Markdown）、**对话内一句话记账**（短句如「午饭 35 元」直接入账并回执，规则解析不依赖模型；疑问句不会被误记）、**对话内长期记忆**（「记住我明年买房」直接存库并回执，同样无需模型）、**多轮追问**（已接入模型时，「那上个月呢？」这类省略追问会承接财务上下文；未接入模型时不改判，避免用「本月」数据冒充上月）、**真 agent 模式**（接入模型后，财务问题由模型自主调用工具：查持仓 / 查账本 / 风控扫描 / 记账 / 查预算 / 查趋势 / 查K线 / **查目标 / 查与记长期记忆 / 跑财务体检**，多轮工具循环，过程以「已调用工具」实时展示；失败自动降级内置分析）、**「帮我体检」关键词路由**（「体检/存够/攒钱/首付/买房/还差多少」等直达财务，无模型也能输出五维报告；「人生目标」这类宽泛问法不误伤），**每条回答标注来源徽标（AI 生成 / 内置分析）**，未接入时页内引导接入；来源与**调用过的工具**一并落库，重开历史会话仍可看到当初是模型作答还是规则算出 |
| **每日晨报** | APScheduler 定时生成（cron 即改即生效），设置页可查看最近晨报历史；**空库不生成**（无数据时点击会提示"还没有数据"，不产出无意义晨报） |
| **预算** | 月度总预算 + 分类预算，仪表盘实时展示进度、剩余日均、超支预警（<80% 绿 / ≥80% 黄 / 超支红） |
| **设置** | 偏好（浅色 / 深色 / 跟随系统、语音提问）、账本规则（月收入 / 应急金目标 / 必要支出类别 / 储蓄率目标）、预算、AI 回答、每日晨报（历史）、**长期记忆（AI 记住用户长期信息：新增 / 删除 / 清空，问答自动参考）**、数据与状态（恢复示例 / 全量 JSON 导出与**导入恢复**，含目标与记忆）、访问口令 |
| **PWA** | 可安装、离线壳加载、断网数据降级提示、图标/主题色/manifest 完整 |

## 📸 界面预览

| | | |
|---|---|---|
| ![仪表盘](docs/preview/23-budget-dashboard.png) | ![一句话记账](docs/preview/25-nl-ledger.png) | ![CSV 导入](docs/preview/26-import-preview.png) |
| 仪表盘（预算 + 待扣提醒） | 一句话记账 | 账单 CSV 导入 |
| ![待扣提醒](docs/preview/27-due-reminder.png) | ![AI 设置](docs/preview/22-ai-settings.png) | ![PWA 离线](docs/preview/21-pwa-offline-v2.png) |
| 本月待扣提醒 | AI 回答配置 | PWA 离线壳 |

## 🚀 快速开始

**环境要求**：Python **3.9+**（建议 3.10+，CI 用 3.12）；Node.js **20.19+ / 22.12+**（Vite 7 要求，含 npm）。版本过低会装不上依赖或直接 import 报错。

```bash
# 后端（依赖见 backend/requirements.txt；必须在 backend 目录内启动）
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

> 注意：**后端 8787 的首页是前端产物（frontend/dist）**。未构建前端时访问 `http://127.0.0.1:8787` 只会看到一行 JSON 提示「前端未构建」，这是正常的——构建后再刷新即可（或直接走 `npm run dev` 的 5199 端口）。

**一键开发启动**（仓库根目录执行，自动建 venv / 装依赖 / 起前后端）：

```bash
scripts/dev.sh   # 后端 8787 + 前端 dev 5199，Ctrl-C 一起退出
```

**Docker 部署**（单容器，前端构建产物 + 后端同端口）：

```bash
docker compose up -d --build     # 或 docker build -t xiaoman . && docker run -p 8787:8787 -v wo-data:/app/backend/data xiaoman
```

容器内数据存 `/app/backend/data`（volume 持久化）；外网访问需设 `API_TOKEN`，否则 Host 防护只放行本机——反代/服务器部署时在 compose 里填 `API_TOKEN` 与 `ALLOWED_HOSTS`（逗号分隔白名单）。

首次运行自动种入一套示例数据（相对当前日期生成，保证"本月"口径可看），仪表盘顶部会常驻横幅明说「当前显示的是示例数据，不是你的真实账本」并给出「记我的第一笔」入口；可在「记账」页替换成自己的真实数据。**老库即使用户清空了持仓也绝不重新播种**，清空后总览降级为引导卡，不会拿示例数据糊弄你。
**AI 优先，未接入有引导**：默认启用 AI 回答，在「设置 → AI 回答」里填入任一 OpenAI 兼容端点（Base URL / Key / 模型）即生效，Key 仅存本机数据库；三要素未配或调用失败自动回退内置确定性分析（回答带来源徽标，问答页显示接入引导条）。
**问答是通用助手，财务是增强层**：不含财务关键词的问题走通用问答（`route=general`），此时**不向模型发送任何持仓/账本数据**、回答不挂财务免责声明；命中财务关键词才走确定性分析。空库时问财务问题得到的是录入引导，不是"总市值 0 元"式的零值报告。

## 🏗 架构

```
用户端（手机优先）→ 前端 Vite + React（仪表盘 ECharts / 问答 / 记账 / 设置 / PWA；framer-motion 页面转场 + Radix Dialog/Tooltip/确认框）
  → FastAPI：REST + SSE + 静态托管 + 最小鉴权（API_TOKEN，Bearer 头）
  → 应用层：
       【LangGraph 多智能体编排图（agent_graph.py）】—— 主执行路径
           supervisor（分类 agent：规则兜底 + 一句话记账/记忆指令检测）
             ├→ record          记账 agent（规则秒回入账）
             ├→ memory          记忆 agent（「记住…」直接存长期记忆，无需模型）
             ├→ general         通用 agent（带会话记忆、不带财务数据）
             └→ collect_market → collect_ledger → risk → finalize
                 市场 agent      账本 agent      风控 agent  成文 agent
             （图负责编排与状态流转；节点间顺序边，适配单连接 SQLite）
       确定性分析内核（analysis.py）—— 所有数字的唯一计算源
       agent 工具层（agent.py + tools.py）—— 成文节点内的 function calling 多轮工具循环
           工具：get_market_view / get_ledger_view / get_risk_flags / get_budget /
                 get_trend / record_transaction / get_kline / get_goals /
                 get_user_memory / save_user_memory / get_health_check（数字仍由本地确定性计算）
           未接入或调用失败 → 自动降级确定性路径（数字不依赖模型）
       LLM 接入（llm.py，OpenAI 兼容端点流式/JSON）+ 自然语言记账（nlparse.py 规则秒回 + AI 兜底）
             + 账单导入（csvimport.py 列映射 + 分类识别）
  → 数据层：SQLite（aiosqlite + WAL）持仓/流水/负债/订阅/预算/设置/**目标/长期记忆**/问答历史（含来源与工具记录）
  → 外部：东方财富行情（异步、超时、失败降级快照；K线独立端点）
```

问答流程（`service.py → agent_graph.py`）：图内 supervisor 规则分类意图 → 一句话记账优先 →
「记住/记得…」记忆指令次之 → 通用问题走通用 agent（不携带财务数据）→ 财务问题按
「市场 agent → 账本 agent → 风控 agent → 成文 agent」管线执行；「体检/存够/买房」等目标词
路由为全量财务（市场+账本都查），成文节点无模型时直接输出五维体检报告（空库则走记账引导，不报分数假象）；
已接入模型则成文节点交给 function calling 工具循环（模型自主调工具取数 → 成文），
否则走确定性模板成文。agent 工具循环失败在成文节点内降级（图内降级）；图本身异常由 API 层如实转成 SSE error 事件。

> 为什么引入 LangGraph（2026 主流 agent 编排框架）：项目要支撑的 agent 能力会持续变多
> （更多专门 agent、工具、记忆、人工介入、重试），裸顺序流程无法承载多智能体状态机与条件路由。
> LangGraph 提供标准的状态图编排，而数字正确性仍由本地确定性内核保证——**框架管编排，内核管算数**。
> 模型调用沿用项目自有的 llm.py（openai 3.x 已适配），不引入 langchain-openai，避免版本耦合。

## 📁 目录

```
backend/app/
  db.py        数据层：aiosqlite 单连接 + WAL；schema + 增量迁移；预算/会话等
  analysis.py  确定性分析内核：持仓/现金流/负债/应急金/集中度/风控规则 + 模板叙述
  quotes.py    行情层：东财 push2 异步批量行情（免 key）+ 快照降级 + 缓存
  llm.py       模型接入：OpenAI 兼容端点，流式问答 + 非流式 JSON 解析
  nlparse.py   一句话记账：规则引擎（金额/日期/收支/分类）+ AI 兜底
  csvimport.py 账单 CSV：解析、表头列映射、收支与分类识别
  tools.py     agent 工具层：把确定性内核暴露为 function calling 工具（schema + 执行体 + 结果截断）
  agent.py     agent 工具循环：LLM function calling 多轮循环（失败抛 AgentUnavailable 供降级）
  agent_graph.py LangGraph 多智能体编排图：supervisor 分类 + 各专门 agent 节点 + 条件路由（主执行路径）
  service.py   问答服务：start 事件 → 调用编排图 → 归档（含工具记录）；纯函数供图节点复用
  scheduler.py 定时晨报：APScheduler（cron，设置即改即生效）
  main.py      FastAPI：REST + SSE + 鉴权中间件 + 静态托管 + 备份恢复/K线/CSV导出
frontend/src/
  App.tsx              布局：移动端底部导航 / 桌面端顶部导航
  components/Dashboard.tsx    仪表盘（统计卡 + ECharts + 预算/待扣提醒 + 风控 + 持仓表）
  components/ChatView.tsx     问答（真流式、agent 工具过程展示、重新生成、建议 chips、分析过程折叠、语音）
  components/EntryView.tsx    记账（一句话记账 / CSV 导入 / 订阅管理 / 流水搜索 / 持仓/流水/负债/订阅增删）
  components/PositionsTable.tsx 持仓表（排序 + 点标的看 K 线弹层）
  components/SettingsView.tsx 设置（分界面导航：偏好/账本规则/预算/AI 回答/晨报/数据与状态（导出+导入恢复）/口令）
  lib/api.ts           请求封装（Bearer 口令、401 应用内口令框、超时）
  lib/utils.ts         cn = clsx + tailwind-merge（类名合并行业标准）
  lib/store.ts         极简全局状态
  lib/charts.ts        ECharts 按需注册 + 运行时懒加载（不进首屏包）
frontend/tests/
  ui-checks.mjs        UI 断言单入口（78 项：chat-first 首屏/空数据降级/结构/懒加载/新组件/AI接入与来源/待扣跨月/应急金态/目标/体检/记忆）
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
| `GET /api/dashboard` | 仪表盘全量数据（持仓/账本/负债/预算/风控/来源/**目标进度**，一次拉取） |
| `POST /api/positions` · `DELETE /api/positions/{symbol}` | 增/删持仓 |
| `POST /api/transactions` · `DELETE /api/transactions/{id}` | 增/删流水 |
| `POST /api/nl-add` | 一句话记账（规则秒回 / AI 兜底，返回 `source: rule\|ai`） |
| `POST /api/import/csv` · `POST /api/import/commit` | 账单 CSV：解析预览 / 批量入账 |
| `GET /api/budgets` · `PUT /api/budgets` | 预算：读取本月设置与实时使用率 / 保存（总预算 `__total` + 分类） |
| `POST /api/debts` · `DELETE /api/debts/{name}` | 增/删负债（含每月还款日 due_day） |
| `POST /api/subscriptions` · `DELETE /api/subscriptions/{name}` | 增/删订阅（含扣款日 due_day） |
| `GET /api/goals` · `POST /api/goals` · `PUT/DELETE /api/goals/{name}` | 财务目标：列表（含进度/建议月存）/ 新增 / 更新 / 删除 |
| `GET /api/memory` · `POST /api/memory` · `DELETE /api/memory/{id}` · `POST /api/memory/clear` | 长期记忆：列表 / 新增（内容相同去重）/ 删除 / 清空 |
| `GET /api/health-check` | 财务体检：资产配置 / 现金流 / 负债 / 应急金 / 目标进度 五维评分与建议 |
| `GET /api/settings` · `PUT /api/settings` | 读/写设置（校验 + 部分更新 + AI 配置即改即生效） |
| `POST /api/ask` | SSE 流式问答（事件：start/step/**agent_step**/text/final/done；agent_step 携带工具名与结果摘要；支持 regenerate 替换回答） |
| `GET /api/history` · `POST /api/export` | 问答历史（含来源与工具记录）/ 全量 JSON 备份（version 2） |
| `POST /api/import/backup` | 从备份 JSON 恢复全量数据（AI Key 除外，事务回滚） |
| `GET /api/export/csv` | 流水导出 CSV（带 BOM，Excel 直开） |
| `GET /api/kline` | 某标的 K 线（A股/ETF，daily/weekly/monthly） |
| `POST /api/reports/generate` · `GET /api/reports` | 手动生成 / 查看晨报 |
| `POST /api/portfolio/reset` | 恢复示例数据 |

**鉴权**：设置 `API_TOKEN` 后，所有 `/api/*`（除 health）需带 `Authorization: Bearer <口令>`
或查询参数 `?token=<口令>`；前端首次遇到 401 会提示输入口令并记住。未设置口令时启用 Host/Origin 防护：仅放行本机地址与 `ALLOWED_HOSTS` 白名单（防 DNS rebinding 与跨站读取），`/api/health` 恒免检。

## 🧪 测试与检查

```bash
cd backend && .venv/bin/python -m pytest tests -q   # 167 项：分析内核/行情/agent 工具循环/LangGraph 多智能体图（结构·路由·事件序列·agent 模式·降级兜底·记忆支路）/API 集成（预算/NL记账/CSV导入/订阅CRUD/备份恢复/K线/CSV导出/应急金误报/通用路由/对话内记账/多轮上下文/来源可溯源/密钥扫描/空数据路径/Host防护/目标CRUD与进度/长期记忆去重/财务体检五维/体检路由与空库保护/记忆指令/备份覆盖目标记忆等）
cd backend && .venv/bin/python -m ruff check app tests
cd frontend && npm run build                        # tsc + vite build（自动 bump SW 缓存版本）
node frontend/tests/ui-checks.mjs                   # 78 项 UI 断言（需后端已在 8787 运行；依赖 playwright）
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

- **2026-09（查漏补缺：对话可达性）**：补齐新功能的对话入口——目标/体检关键词路由（「体检/存够/攒钱/首付/买房/还差多少」直达全量财务，无模型也能输出五维体检报告，空库走记账引导不给分数假象）；**对话内「记住…」记忆指令**（supervisor 新增 memory 支路，规则级存库回执，疑问句不当）；agent 提示词引导记忆/目标/体检工具 + 工具摘要补齐（顺带修掉 `_tool_summary` 对列表结果的既有 bug：get_trend/get_goals 摘要此前从未生效）；首屏建议 chips 加「帮我体检一下财务状况」；备份恢复测试覆盖目标与记忆两表。
- **2026-09（落地扩展：目标 · 记忆 · 体检）**：新增**财务目标**（目标/已存/截止月/建议月存，记账页目标 tab + 总览目标卡 + 快捷 +1k/-1k）、**长期记忆**（AI 记住用户长期信息，工具 `get_user_memory`/`save_user_memory`，设置页管理，内容相同自动去重）、**结构化财务体检**（资产配置/现金流/负债/应急金/目标进度五维评分，总览一键弹层，工具 `get_health_check`）；agent 工具扩到 11 个（+`get_goals`）；备份导出/恢复覆盖目标与记忆两表。
- **2026-09（全栈现代化 + 单路径化）**：前端全面升级到主流大版本——React 19 / Vite 7 / Tailwind CSS 4（`@theme inline` 语义色映射，视觉零变化）/ TypeScript 7，移除 tailwind.config.js 与 postcss.config.js；后端移除旧顺序流程双轨（`_legacy`/`_run_finance_deterministic` 已删），LangGraph 图成为唯一执行路径，agent 工具循环失败在成文节点内降级（图内降级，不中断、不冒充）；记账节点复用 service 唯一实现。
- **2026-09（LangGraph 多智能体编排）**：引入 LangGraph 1.x 主流 agent 编排框架，问答链路重构为状态图——supervisor 分类 agent（规则路由）条件路由到记账 / 通用 / 财务三条支路，财务支路按「市场 agent → 账本 agent → 风控 agent → 成文 agent」管线执行；新增 9 项图结构/路由/事件/降级测试（142→151）；模型调用仍走自研 llm.py（openai 3.x），不引入 langchain-openai。
- **2026-09（agent 升级）**：接入真 agent 工具循环（function calling：查持仓/账本/风控/记账/预算/趋势/K线，过程实时展示、调用记录落库、失败自动降级）；订阅增删、备份导入恢复、K 线端点与弹层、流水搜索、CSV 导出、口令改应用内对话框（弃用 window.prompt）、请求超时、cn 升级为 clsx+tailwind-merge、Docker 部署、一键启动脚本。
- **2026-09**：预算管理、一句话记账、账单 CSV 导入、还款/订阅扣款日提醒、PWA、会话搜索、回答重新生成、AI 问答接入、品牌系统（四套主题）、移动端适配、全量审查修复 29 项。
