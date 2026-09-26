import { useState } from "react";
import { Plus, Trash2, Sparkles, FileUp, Landmark, Repeat, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/lib/toast";
import { api } from "@/lib/api";
import { store as appStore } from "@/lib/store";
import { fmtMoney } from "@/lib/format";
import { PositionsTable } from "@/components/PositionsTable";

const KIND_OPTIONS = ["股票", "ETF", "基金", "现金", "其他"];
const CATEGORY_OPTIONS = ["收入", "餐饮", "居住", "交通", "购物", "订阅", "投资", "还款", "其他"];

function today(): string {
  // 用本地时间拼 YYYY-MM-DD（toISOString 是 UTC，东八区凌晨会取到前一天）
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function Section({
  title,
  badge,
  children,
}: {
  title: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card className="p-[var(--card-pad)]">
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-medium">{title}</div>
        {badge}
      </div>
      {children}
    </Card>
  );
}

const inputCls =
  "w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring";
const labelCls = "block text-xs text-muted-foreground mb-1";

function PositionForm({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({
    symbol: "",
    name: "",
    kind: "股票",
    industry: "其他",
    shares: "",
    cost: "",
    last: "",
  });
  const [err, setErr] = useState("");

  const submit = async () => {
    setErr("");
    try {
      await api("/api/positions", {
        method: "POST",
        body: JSON.stringify({
          symbol: f.symbol.trim(),
          name: f.name.trim(),
          kind: f.kind,
          industry: f.industry.trim() || "其他",
          shares: Number(f.shares),
          cost: Number(f.cost),
          last: Number(f.last),
        }),
      });
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="space-y-2.5">
      <div className="grid grid-cols-2 gap-2.5">
        <div>
          <label className={labelCls}>代码（如 600519）</label>
          <input className={inputCls} value={f.symbol} onChange={(e) => setF({ ...f, symbol: e.target.value })} placeholder="600519" />
        </div>
        <div>
          <label className={labelCls}>名称</label>
          <input className={inputCls} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="贵州茅台" />
        </div>
        <div>
          <label className={labelCls}>类型</label>
          <select className={inputCls} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            {KIND_OPTIONS.map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls}>行业</label>
          <input className={inputCls} value={f.industry} onChange={(e) => setF({ ...f, industry: e.target.value })} placeholder="白酒" />
        </div>
        <div>
          <label className={labelCls}>股数/份额</label>
          <input className={inputCls} type="number" value={f.shares} onChange={(e) => setF({ ...f, shares: e.target.value })} placeholder="100" />
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          <div>
            <label className={labelCls}>成本价</label>
            <input className={inputCls} type="number" value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value })} placeholder="1680" />
          </div>
          <div>
            <label className={labelCls}>现价</label>
            <input className={inputCls} type="number" value={f.last} onChange={(e) => setF({ ...f, last: e.target.value })} placeholder="1521" />
          </div>
        </div>
      </div>
      {err && <div className="text-xs text-red-600 dark:text-red-400">{err}</div>}
      <Button size="sm" onClick={() => void submit()} disabled={!f.symbol || !f.shares || !f.cost || !f.last}>
        <Plus className="w-3.5 h-3.5" /> 添加持仓
      </Button>
    </div>
  );
}

function TransactionForm({ onDone, defaultCategory = "餐饮" }: { onDone: () => void; defaultCategory?: string }) {
  const [f, setF] = useState({ date: today(), item: "", category: defaultCategory, amount: "" });
  const [err, setErr] = useState("");

  const submit = async () => {
    setErr("");
    const amount = Number(f.amount);
    try {
      await api("/api/transactions", {
        method: "POST",
        body: JSON.stringify({
          date: f.date,
          item: f.item.trim(),
          category: f.category,
          amount: f.category === "收入" ? Math.abs(amount) : -Math.abs(amount),
        }),
      });
      setF({ date: today(), item: "", category: defaultCategory, amount: "" });
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="space-y-2.5">
      <div className="grid grid-cols-2 gap-2.5">
        <div>
          <label className={labelCls}>日期</label>
          <input className={inputCls} type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
        </div>
        <div>
          <label className={labelCls}>分类</label>
          <select className={inputCls} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
            {CATEGORY_OPTIONS.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls}>名称</label>
          <input className={inputCls} value={f.item} onChange={(e) => setF({ ...f, item: e.target.value })} placeholder="午餐 / 工资" />
        </div>
        <div>
          <label className={labelCls}>金额</label>
          <input className={inputCls} type="number" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder="66" />
        </div>
      </div>
      <div className="text-[11px] text-muted-foreground">
        选择「收入」记为正数，其余分类记支出。
      </div>
      {err && <div className="text-xs text-red-600 dark:text-red-400">{err}</div>}
      <Button size="sm" onClick={() => void submit()} disabled={!f.item || !f.amount}>
        <Plus className="w-3.5 h-3.5" /> 记一笔
      </Button>
    </div>
  );
}

/** 一句话记账：规则解析秒回，复杂句自动升级 AI；成功直接入账。 */function NlForm({ onDone }: { onDone: () => void }) {
  const { toast } = useToast();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const samples = ["昨天打车 32 元", "工资 8000 已到账", "买了件衣服 299"];

  const submit = async (s?: string) => {
    const q = (s ?? text).trim();
    if (!q || busy) return;
    setBusy(true);
    try {
      const r = await api<{ source: string; transaction: { item: string; category: string; amount: number; date: string } }>("/api/nl-add", {
        method: "POST",
        body: JSON.stringify({ text: q }),
      });
      const t = r.transaction;
      toast(
        `已记：${t.category} ${fmtMoney(t.amount, true)}（${t.item} · ${t.date}）${r.source === "ai" ? " · AI 识别" : ""}`,
        "ok",
      );
      setText("");
      onDone();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-3 rounded-xl border border-primary/20 bg-primary/5 p-3">
      <div className="flex items-center gap-1.5 text-xs font-medium mb-1.5">
        <Sparkles className="w-3.5 h-3.5 text-primary" />
        一句话记账
      </div>
      <div className="flex gap-2">
        <input
          className={inputCls}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
          placeholder="例如：昨天打车 32 元"
        />
        <Button size="sm" onClick={() => void submit()} disabled={busy || !text.trim()}>
          {busy ? "识别中…" : "记一笔"}
        </Button>
      </div>
      <div className="mt-1.5 flex gap-1.5 flex-wrap">
        {samples.map((s) => (
          <button
            key={s}
            className="rounded-full bg-background border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:text-primary hover:border-primary/40"
            onClick={() => void submit(s)}
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

interface ImportPreview {
  columns: string[];
  mapping: { date: number; amount: number; type: number; desc: number };
  preview: { date: string; item: string; category: string; amount: number }[];
  rows: { date: string; item: string; category: string; amount: number }[];
  total: number;
  skipped: number;
}

/** 账单 CSV 导入：粘贴 → 解析预览（自动识别列/分类）→ 确认批量入账。 */
function ImportPanel({ onDone }: { onDone: () => void }) {
  const { toast } = useToast();
  const [content, setContent] = useState("");
  const [parsed, setParsed] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);

  const parse = async () => {
    if (!content.trim()) return;
    setBusy(true);
    try {
      const r = await api<ImportPreview>("/api/import/csv", {
        method: "POST",
        body: JSON.stringify({ content }),
      });
      setParsed(r);
    } catch (e) {
      setParsed(null);
      toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!parsed) return;
    setImporting(true);
    try {
      const r = await api<{ imported: number; failed: string[] }>("/api/import/commit", {
        method: "POST",
        body: JSON.stringify({ rows: parsed.rows }),
      });
      toast(r.failed.length ? `导入 ${r.imported} 条，跳过 ${r.failed.length} 条` : `已导入 ${r.imported} 笔账单`, r.failed.length ? "error" : "ok");
      setContent("");
      setParsed(null);
      onDone();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setImporting(false);
    }
  };

  const readFile = (file: File) => {
    // 支付宝/部分银行导出的 CSV 是 GBK：先按 UTF-8 读，出现替换符再按 GBK 重读
    file
      .text()
      .then((text) => {
        if (!text.includes("\uFFFD")) return text;
        return file.arrayBuffer().then((buf) => new TextDecoder("gbk").decode(buf));
      })
      .then((text) => setContent(text))
      .catch(() => toast("文件读取失败", "error"));
  };

  return (
    <div className="mb-3 rounded-xl border border-border/70 p-3">
      <div className="text-xs font-medium mb-1.5">导入账单（CSV）</div>
      <div className="text-[11px] text-muted-foreground mb-2">
        支持微信 / 支付宝 / 银行导出的账单 CSV，自动识别日期、金额、收支与分类
      </div>
      <textarea
        className={`${inputCls} min-h-16`}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder={"粘贴 CSV 内容，或点击右侧上传文件…\n示例：交易时间,交易类型,交易对方,金额"}
      />
      <div className="mt-2 flex gap-2">
        <Button size="sm" variant="outline" onClick={() => void parse()} disabled={busy || !content.trim()}>
          {busy ? "解析中…" : "解析预览"}
        </Button>
        <label className="inline-flex items-center text-xs text-muted-foreground cursor-pointer hover:text-primary">
          上传文件
          <input
            type="file"
            accept=".csv,.txt,text/csv,text/plain"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) readFile(f);
              e.target.value = "";
            }}
          />
        </label>
      </div>

      {parsed && (
        <div className="mt-3 border-t border-border/60 pt-3">
          <div className="text-xs mb-2">
            识别到 <b className="tabular-nums">{parsed.total}</b> 条可导入
            {parsed.skipped > 0 && <span className="text-muted-foreground"> · 跳过 {parsed.skipped} 条（缺金额/日期）</span>}
          </div>
          <div className="overflow-x-auto scroll-thin">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground text-left">
                  <th className="py-1 pr-3">日期</th>
                  <th className="py-1 pr-3">名称</th>
                  <th className="py-1 pr-3">分类</th>
                  <th className="py-1 text-right">金额</th>
                </tr>
              </thead>
              <tbody>
                {parsed.preview.map((p, i) => (
                  <tr key={i} className="border-t border-border/40">
                    <td className="py-1 pr-3 tabular-nums">{p.date}</td>
                    <td className="py-1 pr-3 truncate max-w-32">{p.item}</td>
                    <td className="py-1 pr-3">{p.category}</td>
                    <td className={`py-1 text-right tabular-nums ${p.amount > 0 ? "text-up" : "text-down"}`}>{fmtMoney(p.amount, true)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-2 flex gap-2">
            <Button size="sm" onClick={() => void commit()} disabled={importing || parsed.total === 0}>
              {importing ? "导入中…" : `确认导入 ${parsed.total} 条`}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setParsed(null)}>
              取消
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function DebtForm({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ name: "", monthly: "", balance: "", rate: "", dueDay: "" });
  const [err, setErr] = useState("");

  const submit = async () => {
    setErr("");
    try {
      await api("/api/debts", {
        method: "POST",
        body: JSON.stringify({
          name: f.name.trim(),
          monthly: Number(f.monthly),
          balance: Number(f.balance),
          rate: Number(f.rate) / 100,
          due_day: f.dueDay.trim(),
        }),
      });
      setF({ name: "", monthly: "", balance: "", rate: "", dueDay: "" });
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="space-y-2.5">
      <div className="grid grid-cols-2 gap-2.5">
        <div>
          <label className={labelCls}>名称</label>
          <input className={inputCls} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="房贷 / 信用卡分期" />
        </div>
        <div>
          <label className={labelCls}>月供（元）</label>
          <input className={inputCls} type="number" value={f.monthly} onChange={(e) => setF({ ...f, monthly: e.target.value })} placeholder="6800" />
        </div>
        <div>
          <label className={labelCls}>余额（元）</label>
          <input className={inputCls} type="number" value={f.balance} onChange={(e) => setF({ ...f, balance: e.target.value })} placeholder="1280000" />
        </div>
        <div>
          <label className={labelCls}>年利率（%）</label>
          <input className={inputCls} type="number" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} placeholder="3.45" />
        </div>
        <div>
          <label className={labelCls}>每月还款日（几号，可留空）</label>
          <input className={inputCls} type="number" min="1" max="31" value={f.dueDay} onChange={(e) => setF({ ...f, dueDay: e.target.value })} placeholder="15" />
        </div>
      </div>
      {err && <div className="text-xs text-red-600 dark:text-red-400">{err}</div>}
      <Button size="sm" onClick={() => void submit()} disabled={!f.name}>
        <Plus className="w-3.5 h-3.5" /> 添加负债
      </Button>
    </div>
  );
}

type ListTab = "transactions" | "positions" | "debts" | "subscriptions";
type Panel = "expense" | "income" | "import" | "position" | "debt" | null;

export function EntryView() {
  const { dashboard } = appStore.useApp();
  const [tab, setTab] = useState<ListTab>("transactions");
  const [panel, setPanel] = useState<Panel>(null);

  const actions: { id: Panel; label: string; icon: React.ReactNode }[] = [
    { id: "expense", label: "记支出", icon: <Plus className="w-3.5 h-3.5" /> },
    { id: "income", label: "记收入", icon: <Wallet className="w-3.5 h-3.5" /> },
    { id: "import", label: "导入账单", icon: <FileUp className="w-3.5 h-3.5" /> },
    { id: "position", label: "管理持仓", icon: <Sparkles className="w-3.5 h-3.5" /> },
    { id: "debt", label: "添加负债", icon: <Landmark className="w-3.5 h-3.5" /> },
  ];

  const tabs: { id: ListTab; label: string; count?: number }[] = [
    { id: "transactions", label: "流水", count: dashboard?.transactions.length },
    { id: "positions", label: "持仓", count: dashboard?.positions.length },
    { id: "debts", label: "负债", count: dashboard?.debts.items.length },
    { id: "subscriptions", label: "订阅", count: dashboard?.subscriptions.items.length },
  ];

  const openPanel = (id: Panel) => setPanel((cur) => (cur === id ? null : id));

  return (
    <div className="space-y-3">
      {/* 主入口：一句话记账，永远在最上面 */}
      <NlForm onDone={() => appStore.bump()} />

      {/* 快捷动作：点开哪个显示哪个，不全部铺开 */}
      <div className="flex gap-2 flex-wrap">
        {actions.map((a) => (
          <Button
            key={a.id}
            size="sm"
            variant={panel === a.id ? "default" : "outline"}
            onClick={() => openPanel(a.id)}
          >
            {a.icon} {a.label}
          </Button>
        ))}
      </div>

      {panel === "expense" && (
        <Section title="记一笔支出">
          <TransactionForm defaultCategory="餐饮" onDone={() => appStore.bump()} />
        </Section>
      )}
      {panel === "income" && (
        <Section title="记一笔收入">
          <TransactionForm defaultCategory="收入" onDone={() => appStore.bump()} />
        </Section>
      )}
      {panel === "import" && <ImportPanel onDone={() => appStore.bump()} />}
      {panel === "position" && (
        <Section title="添加持仓" badge={<Badge variant="muted">现价用于估算市值，也可等行情自动更新</Badge>}>
          <PositionForm onDone={() => appStore.bump()} />
        </Section>
      )}
      {panel === "debt" && (
        <Section title="添加负债">
          <DebtForm onDone={() => appStore.bump()} />
        </Section>
      )}

      {/* 列表管理：流水 / 持仓 / 负债 / 订阅 */}
      <Section
        title="我的账本"
        badge={
          <div className="flex gap-1.5">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors ${
                  tab === t.id
                    ? "bg-primary/15 text-primary"
                    : "bg-muted text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
                {t.count != null && <span className="ml-1 tabular-nums">{t.count}</span>}
              </button>
            ))}
          </div>
        }
      >
        {tab === "transactions" && (
          dashboard && dashboard.transactions.length > 0 ? (
            <div className="max-h-96 overflow-y-auto scroll-thin">
              {dashboard.transactions.slice(0, 100).map((t) => (
                <div key={t.id} className="flex items-center justify-between py-1.5 text-sm">
                  <span className="min-w-0">
                    <span className="truncate">{t.item}</span>
                    <span className="text-muted-foreground text-xs ml-2">{t.date} · {t.category}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className={`tabular-nums ${t.amount > 0 ? "text-up" : "text-down"}`}>
                      {fmtMoney(t.amount, true)}
                    </span>
                    <button
                      className="text-muted-foreground hover:text-red-600"
                      onClick={() => {
                        void api(`/api/transactions/${t.id}`, { method: "DELETE" }).then(() => appStore.bump());
                      }}
                      aria-label={`删除 ${t.item}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </span>
                </div>
              ))}
              {dashboard.transactions.length > 100 && (
                <div className="py-2 text-center text-xs text-muted-foreground">
                  仅显示最近 100 条，共 {dashboard.transactions.length} 条
                </div>
              )}
            </div>
          ) : (
            <div className="py-6 text-center text-sm text-muted-foreground">
              还没有流水，用上方「一句话记账」记第一笔吧
            </div>
          )
        )}

        {tab === "positions" && (
          dashboard && dashboard.positions.length > 0 ? (
            <div className="space-y-3">
              <PositionsTable rows={dashboard.positions} />
              <div className="space-y-1.5">
                {dashboard.positions.map((p) => (
                  <div key={p.symbol} className="flex items-center justify-between text-sm">
                    <span>
                      {p.name} <span className="text-muted-foreground text-xs">{p.symbol}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="tabular-nums text-muted-foreground">{p.shares} 份</span>
                      <button
                        className="text-muted-foreground hover:text-red-600"
                        onClick={() => {
                          void api(`/api/positions/${p.symbol}`, { method: "DELETE" }).then(() => appStore.bump());
                        }}
                        aria-label={`删除 ${p.name}`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="py-6 text-center text-sm text-muted-foreground">
              暂无持仓，点上方「管理持仓」添加
            </div>
          )
        )}

        {tab === "debts" && (
          dashboard && dashboard.debts.items.length > 0 ? (
            <div>
              {dashboard.debts.items.map((d) => (
                <div key={d.name} className="flex items-center justify-between py-1.5 text-sm">
                  <span>
                    {d.name} <span className="text-muted-foreground text-xs">{(d.rate * 100).toFixed(1)}%</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="tabular-nums text-muted-foreground">{fmtMoney(d.monthly)}/月</span>
                    <button
                      className="text-muted-foreground hover:text-red-600"
                      onClick={() => {
                        void api(`/api/debts/${encodeURIComponent(d.name)}`, { method: "DELETE" }).then(() => appStore.bump());
                      }}
                      aria-label={`删除 ${d.name}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="py-6 text-center text-sm text-muted-foreground">无负债记录</div>
          )
        )}

        {tab === "subscriptions" && (
          <div>
            {dashboard && dashboard.subscriptions.items.length > 0 ? (
              <ul className="space-y-1.5">
                {dashboard.subscriptions.items.map((s) => (
                  <li key={s.name} className="flex items-center justify-between text-sm">
                    <span>
                      <Repeat className="w-3.5 h-3.5 inline mr-1.5 text-muted-foreground" />
                      {s.name}
                      {s.due_day && <span className="text-xs text-muted-foreground ml-1.5">{s.due_day} 号扣</span>}
                    </span>
                    <span className="tabular-nums text-muted-foreground">{fmtMoney(s.monthly)}/月</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="py-6 text-center text-sm text-muted-foreground">无订阅记录</div>
            )}
            <div className="mt-3 text-[11px] text-muted-foreground">
              订阅目前只读展示，月支出合计 {fmtMoney(dashboard?.subscriptions.monthly_total ?? 0)}。
            </div>
          </div>
        )}
      </Section>
    </div>
  );
}
