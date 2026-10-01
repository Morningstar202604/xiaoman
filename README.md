# 小满 Xiaoman · 慢慢存，小满即富

> **记一笔，问一句** —— 对话优先的个人理财智能体。**本地运行 × 云端能力**：数据全部存在你自己电脑上，AI 问答与行情走云端 API。开源、免费、开箱即用。

![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)
![Python 3.10+](https://img.shields.io/badge/Python-3.10+-blue.svg)
![FastAPI](https://img.shields.io/badge/FastAPI-0.115-009688.svg)
![React 19](https://img.shields.io/badge/React-19-61DAFB.svg)
![LangGraph](https://img.shields.io/badge/LangGraph-1.x-1A2B4A.svg)
![PWA](https://img.shields.io/badge/PWA-ready-5B8DEF.svg)
[![中文](https://img.shields.io/badge/简体中文-README-green.svg)](README.md)
[![English](https://img.shields.io/badge/English-README--en-blue.svg)](README.en.md)

小满——二十四节气里谷物渐满未满的时节。理财同理：不求一夜暴富，每天攒一点，日子自有分寸地饱满起来。它不是又一个记账 App，而是**住在对话里的理财助手**：你说一句话，它帮你记账、看行情、管持仓、做体检、出晨报。

**为什么值得一试：**

- 🗣️ **对话即中枢** —— 记账、查行情、加自选、买卖持仓、生成晨报、加密备份、改设置，全都能在问AI里一句话完成，其余页面只是对话结果的视图
- 🔒 **数据 100% 本地** —— 所有财务数据只存本机 SQLite，不依赖任何云端数据库；可设置口令导出加密备份包（PBKDF2 + Fernet），口令不落盘
- 🇨🇳 **国产优先** —— 预置 DeepSeek / 豆包 / 通义千问 / 云知声等国内模型端点；行情三级降级（东财 → 新浪 → 快照价），可用性优先
- 🧭 **投资者心智** —— 界面按炒股、买基金、理财的真实心智组织：总览 / 持仓 / 行情 / 记账 / 问答 5 页签，红涨绿跌（可切换绿涨红跌）
- 🛡️ **绝不编造数字** —— 所有金额、盈亏、风控指标由确定性内核计算；AI 只做分类与成文，且运行时只暴露只读工具，模型永远无法擅自改你的数据
- 📱 **开箱即用** —— 一键脚本 / Docker 单容器 / PWA 可安装，空库首启有引导，未配 AI 也能完整使用

---

## 截图

| 总览（资产分布 · 持仓速览 · 风控预警） | 持仓（集中度 · 逐笔盈亏） |
|---|---|
| ![总览](docs/screenshots/overview-zh.png) | ![持仓](docs/screenshots/holdings-zh.png) |

| 对话中枢（能力清单 · 一句话工作流） | English UI |
|---|---|
| ![对话中枢](docs/screenshots/chat-zh.png) | ![English](docs/screenshots/overview-en.png) |

---

## 功能总览（5 页签）

| 页签 | 内容 |
|---|---|
| **总览** | 指数行情条 · 资产四卡（总资产/今日盈亏/持仓市值/可用现金）· 资产分布 · Top 持仓 · 预算进度（超支预警）· 提醒条（预算超支/目标临期/待扣款）· 风控横幅 · 财务体检入口 |
| **持仓** | 股票/基金/理财/现金分组 · 集中度与行业风控卡 · 逐笔盈亏（红涨绿跌）· 点标的看 K 线 |
| **行情** | 自选列表（实时价与涨跌、可增删）· 持仓行情 · 搜索 · 单股 K 线弹层 · 行情来源与免责脚注 |
| **记账** | 一句话记账（规则秒回，疑问句不误记）· 账单 CSV 导入 · 流水搜索 · 手工录入 · 负债/订阅/目标管理 |
| **问AI** | 常驻快捷指令 · 真流式 SSE · agent 工具循环（过程实时展示、失败自动降级）· 多会话 · 重新生成 · 一句话记账/长期记忆 · 每日晨报（L1/L2 徽标）· 来源徽标 |

**一条完整工作流**：用户一句话（「看看贵州茅台，合适就加自选」→「买了 100 股成本 1500」）由模型编排 `search_symbol → get_quote → get_kline → add_to_watchlist → record_position`，从找标的到落库全自动，行情页自选、总览与持仓页即时可见。

## 快速开始

环境要求：Python 3.10+；Node.js 20.19+ / 22.12+。

```bash
# 后端（依赖见 backend/requirements.txt；必须在 backend 目录内启动）
cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env          # 可选：填 LLM_* 启用模型（国产端点见 .env.example 注释）
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8787

# 前端：开发模式（热更新，/api 反代到 8787）
cd frontend
npm install && npm run dev    # http://127.0.0.1:5199

# 前端：生产模式（构建后由后端单端口托管）
cd frontend && npm run build  # 然后访问 http://127.0.0.1:8787
```

一键启动（根目录执行）：`scripts/dev.sh`（后端 8787 + 前端 dev 5199）。Docker 部署：`docker compose up -d --build`（单容器同端口 8787，数据卷 `xiaoman-data` 持久化数据与备份）。

- **空库首启**：全新库不种示例数据——各页显示聊天式空态引导，首启弹三步引导（记一笔 → 加自选 → 配 AI），所见即真实数据
- **AI 可选**：设置页填任一 OpenAI 兼容端点即生效；未配置或调用失败自动回退内置确定性分析（带来源徽标）
- **备份**：设置页可全量导出/恢复；**推荐设置备份口令**——带口令导出为加密包（PBKDF2+Fernet），口令不落盘、忘记无法找回

## 对话工作流（几个例子）

| 你说 | 小满做 |
|---|---|
| 「咖啡 28 元，打车 32 元」 | 一句多笔记账，逐条入账 |
| 「工资 1w 到账」 | 记收入 10000（支持 万/w/k、中文数字） |
| 「看看宁德时代，合适就加自选」 | 查行情 → 加自选 → 行情页可见 |
| 「买入 600519 100 股」 | 按现价建仓（行情不可达时提示补成本） |
| 「卖出一半的 600519」 | 半仓卖出，不误清仓 |
| 「记住我下个月要交房租 5000」 | 存入长期记忆，问答自动参考 |
| 「生成今天的晨报 / 备份一下 / 做一次全面体检」 | 晨报归档 / 加密备份 / 五维财务体检 |
| 「默认首页改成持仓」 | 改设置并跳转设置页 |
| 「那上个月呢」 | 承接上一轮账本分析（只读，不越权改数据） |

完整指南见 [docs/WORKFLOW.md](docs/WORKFLOW.md)（英文 [English](docs/WORKFLOW.en.md)）。

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | React 19 + Vite + Tailwind 4 · ECharts 懒加载 · PWA（可安装） |
| 后端 | FastAPI + LangGraph 多智能体编排 · 确定性分析内核 |
| 数据 | SQLite（本地优先，aiosqlite + WAL）· 加密备份（PBKDF2 + Fernet） |
| AI | OpenAI 兼容端点（DeepSeek / 豆包 / 通义 / 云知声预设）· 流式 + function calling |
| 行情 | 东财 → 新浪 → 组合库快照 三级降级 |

## 架构

```
前端（React 5 页签：总览/持仓/行情/记账/问AI）
  → FastAPI：REST + SSE + 静态托管 + 最小鉴权（API_TOKEN）
  → LangGraph 多智能体编排（agent_graph.py）：supervisor 分类 → record/memory/general
      或 collect_market → collect_ledger → risk → finalize（顺序边，适配单连接 SQLite）
  → 确定性分析内核（analysis.py）：所有数字的唯一计算源
  → agent 工具层（agent.py + tools.py）：function calling 多轮工具循环，17 个工具，
      运行时只向模型暴露读类 + 自选维护工具；记账/记忆/买卖/设置/备份/晨报
      等写操作全部由确定性前置分支拦截（防模型越权落库）
  → LLM 接入（llm.py，OpenAI 兼容，国产预设）
  → 数据层：SQLite（持仓/流水/负债/订阅/预算/设置/目标/长期记忆/自选/问答历史）
  → 外部：行情三级降级 东财 → 新浪 → 组合库快照
```

框架管编排、内核管算数：模型只出现在分类与成文两步，任一失败自动降级确定性路径（服务不中断、不冒充模型结果）。

## 目录

```
backend/app/
  main.py       FastAPI：REST + SSE + 鉴权 + 静态托管 + 备份恢复/K线/CSV导出
  db.py         数据层：schema + 增量迁移 + 全部表读写
  analysis.py   确定性分析内核：持仓/现金流/负债/应急金/集中度/风控/模板叙述
  quotes.py     行情层：东财→新浪→快照三级降级 + 统一缓存注册表
  llm.py        模型接入：OpenAI 兼容端点，流式/JSON
  nlparse.py    一句话记账：规则引擎 + AI 兜底
  csvimport.py  账单 CSV：列映射与分类识别
  tools.py      agent 工具层：17 个 function calling 工具
  agent.py      agent 工具循环：LLM function calling 多轮循环
  agent_graph.py LangGraph 编排图：supervisor + 专门节点 + 条件路由
  service.py    问答服务：路由分类/纯函数/事件契约
  scheduler.py  定时晨报：APScheduler
  backup.py     本地加密备份：PBKDF2+Fernet，口令不落盘
frontend/src/
  App.tsx               5 页签布局（桌面顶栏/移动底栏）
  components/           Dashboard / HoldingsView / MarketView / EntryView / ChatView
                        / SettingsView / IndicesStrip / KlineDialog / MorningReportDialog …
  lib/                  api / store / i18n（zh+en）/ charts / format / brand
docs/
  DEPLOY.md / CONFIG.md / WORKFLOW.md   （含 .en 英文版）
  screenshots/                           产品截图
```

## API（节选）

| 端点 | 说明 |
|---|---|
| `GET /api/dashboard` | 总览全量数据（一次拉取） |
| `POST /api/ask` | SSE 流式问答（start/step/agent_step/text/final/done） |
| `GET /api/watchlist` · `POST/DELETE /api/watchlist` | 自选：列表 / 增 / 删 |
| `GET /api/quote` · `GET /api/search` · `GET /api/kline` | 单股实时价 / 搜索 / K 线 |
| `POST /api/nl-add` | 一句话记账（`source: rule\|ai`） |
| `GET/PUT /api/budgets` · `POST/DELETE /api/debts` · `POST/DELETE /api/subscriptions` | 预算 / 负债 / 订阅 |
| `GET/POST/PUT/DELETE /api/goals` · `GET/POST/DELETE /api/memory` | 目标 / 长期记忆 |
| `GET /api/health-check` | 五维财务体检 |
| `GET /api/export?passphrase=` · `POST /api/import/backup` | 备份（带口令加密）/ 恢复 |
| `GET /api/export/csv` · `POST /api/import/csv` | 流水 CSV 导出 / 账单导入 |
| `GET /api/reports` · `POST /api/reports/generate` · `GET /api/scheduler` | 晨报历史 / 生成 / 调度状态 |
| `GET /api/bootstrap` · `GET/PUT /api/settings` · `GET /api/health` | 引导数据 / 设置 / 健康检查 |

**鉴权**：设 `API_TOKEN` 后 `/api/*` 需 `Bearer` 或 `?token=`；未设口令时 Host/Origin 防护仅放行本机与 `ALLOWED_HOSTS` 白名单。

## 配置与文档

- [部署指南（本地 / Docker / 外网 / 备份迁移）](docs/DEPLOY.md) · [English](docs/DEPLOY.en.md)
- [配置说明（环境变量 + 设置项 + AI 端点速查）](docs/CONFIG.md) · [English](docs/CONFIG.en.md)
- [对话工作流（一句话全流程示例）](docs/WORKFLOW.md) · [English](docs/WORKFLOW.en.md)
- 环境变量模板：[backend/.env.example](backend/.env.example)

## 测试与检查

```bash
cd backend && .venv/bin/python -m pytest tests -q    # 182 项：分析内核/行情三级降级/agent 工具循环/LangGraph 图/API 集成/备份加密往返/目标/记忆/体检/密钥扫描
cd backend && .venv/bin/python -m ruff check app tests
cd frontend && npm run build                          # tsc + vite build（自动 bump SW 缓存版本）
```

CI 覆盖后端 ruff + pytest 与前端 tsc + build。

## 数据与隐私

- 所有个人数据只存本机 SQLite；行情走东财/新浪公开接口；模型调用仅在你配置的端点发生。
- 备份推荐带口令加密导出；明文导出会强提示。行情全失败时用组合库快照价，界面标注「离线估值，非实时」。
- 无遥测、无埋点、无第三方统计；卸载即消失。

## 免责声明

本软件输出的全部内容（财务体检、每日晨报、AI 顾问回答、目标与预算建议）**仅供参考，不构成投资建议**，不构成任何收益承诺。市场有风险，投资需谨慎，据此操作风险自担。

## 开源与贡献

- 协议：[MIT](LICENSE) · 行为准则：[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) · 贡献指引：[CONTRIBUTING.md](CONTRIBUTING.md) · 安全说明：[SECURITY.md](SECURITY.md)
- 欢迎提交 Issue / PR、点亮 Star、推荐给需要的朋友。你也可以在 Issue 里提出新功能想法，或分享你的理财小技巧。

**Topics**：`personal-finance` `finance-assistant` `ai-assistant` `chatbot` `stock` `fund` `portfolio` `budget` `sqlite` `fastapi` `langgraph` `react` `pwa` `local-first` `privacy` `中文理财` `记账` `开源理财`

## 更新日志

- **2026-10（收尾查漏补缺）**：四轮全量扫描修复 12 项——理财咨询句不被记账劫持；6 位股票代码买入不误记支出；「加自选」正确触发行情工具；晨报不再无限递归；「卖一半」不误清仓；1w/2k 金额正确换算；首屏补「改设置」能力组；一句多笔记账；省略追问承接账本分析；**【安全】agent 模式只暴露读类工具**；「记住…」优先存记忆。182 用例全绿；备份目录并入数据卷；买入缺行情降级修复。
- **2026-09（投资者心智重构 + 工作流贯通）**：5 页签导航；指数行情条；持仓页（分组+集中度风控）；行情页（自选+持仓双 Tab、搜索、K 线）；红涨绿跌（可切换）；AI 工具扩至 17 个，一句话工作流贯通；快捷指令 chips；总览提醒条；本地加密备份（PBKDF2+Fernet）；行情三级降级；拆解清理；空库首启 + 空态引导 + 首启三步引导；对话中枢（动作工具+跳转联动+能力清单首屏）。
- **2026-09（目标 · 记忆 · 体检）**：财务目标、长期记忆、五维财务体检；对话内「记住…」记忆指令。
- **2026-09（LangGraph 单路径化）**：LangGraph 图成为唯一执行路径；React 19/Vite 7/Tailwind 4 现代化。
- **2026-09（agent 升级）**：真 agent 工具循环、订阅增删、K 线、备份恢复、口令框、Docker、一键启动。
- **2026-09**：预算、一句话记账、CSV 导入、待扣提醒、PWA、会话搜索、重新生成、AI 问答、品牌系统。
