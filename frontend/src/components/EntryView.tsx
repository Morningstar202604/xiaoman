import { useState } from "react";
import { Plus, Trash2, Sparkles, FileUp, Landmark, Repeat, Search, Target, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/lib/toast";
import { useI18n } from "@/lib/i18n";
import { api } from "@/lib/api";
import { store as appStore } from "@/lib/store";
import { fmtMoney } from "@/lib/format";
import { GoalsPanel, GoalsList } from "@/components/GoalsPanel";

const KIND_OPTIONS = ["股票", "ETF", "基金", "现金", "其他"] as const;
const CATEGORY_OPTIONS = ["收入", "餐饮", "居住", "交通", "购物", "订阅", "投资", "还款", "其他"] as const;
// 数据值（提交给后端）保持中文，界面显示按语言翻译
const KIND_LABEL_KEYS: Record<string, string> = {
  股票: "entry.kindStock", ETF: "entry.kindEtf", 基金: "entry.kindFund", 现金: "entry.kindCash", 其他: "entry.kindOther",
};
const CAT_LABEL_KEYS: Record<string, string> = {
  收入: "entry.catIncome", 餐饮: "entry.catFood", 居住: "entry.catHousing", 交通: "entry.catTransport",
  购物: "entry.catShopping", 订阅: "entry.catSubs", 投资: "entry.catInvest", 还款: "entry.catRepay", 其他: "entry.catOther",
};

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
  const { t: tt } = useI18n();
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
      const shares = Number(f.shares);
      const cost = Number(f.cost);
      const last = Number(f.last);
      if (!f.symbol.trim()) {
        setErr(tt("entry.posCodeReq"));
        return;
      }
      if (!(shares > 0) || !(cost >= 0) || !(last >= 0)) {
        setErr(tt("entry.posNumErr"));
        return;
      }
      await api("/api/positions", {
        method: "POST",
        body: JSON.stringify({
          symbol: f.symbol.trim(),
          name: f.name.trim(),
          kind: f.kind,
          industry: f.industry.trim() || "其他",
          shares,
          cost,
          last,
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
          <label className={labelCls}>{tt("entry.posCode")}</label>
          <input className={inputCls} maxLength={6} value={f.symbol} onChange={(e) => setF({ ...f, symbol: e.target.value })} placeholder="600519" />
        </div>
        <div>
          <label className={labelCls}>{tt("entry.name")}</label>
          <input className={inputCls} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={tt("entry.posNamePh")} />
        </div>
        <div>
          <label className={labelCls}>{tt("entry.kind")}</label>
          <select className={inputCls} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            {KIND_OPTIONS.map((k) => (
              <option key={k}>{tt(KIND_LABEL_KEYS[k] ?? "entry.kindOther")}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls}>{tt("entry.industry")}</label>
          <input className={inputCls} value={f.industry} onChange={(e) => setF({ ...f, industry: e.target.value })} placeholder={tt("entry.industryPh")} />
        </div>
        <div>
          <label className={labelCls}>{tt("entry.shares")}</label>
          <input className={inputCls} type="number" value={f.shares} min="0.01" step="any" onChange={(e) => setF({ ...f, shares: e.target.value })} placeholder="100" />
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          <div>
            <label className={labelCls}>{tt("entry.costPrice")}</label>
            <input className={inputCls} type="number" value={f.cost} min="0" step="any" onChange={(e) => setF({ ...f, cost: e.target.value })} placeholder="1680" />
          </div>
          <div>
            <label className={labelCls}>{tt("entry.currentPrice")}</label>
            <input className={inputCls} type="number" value={f.last} min="0" step="any" onChange={(e) => setF({ ...f, last: e.target.value })} placeholder="1521" />
          </div>
        </div>
      </div>
      {err && <div className="text-xs text-red-600 dark:text-red-400">{err}</div>}
      <Button size="sm" onClick={() => void submit()} disabled={!f.symbol || !f.shares || !f.cost || !f.last}>
        <Plus className="w-3.5 h-3.5" /> {tt("entry.addPosition")}
      </Button>
    </div>
  );
}

function TransactionForm({ onDone, defaultCategory = "餐饮" }: { onDone: () => void; defaultCategory?: string }) {
  const { t: tt } = useI18n();
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
          <label className={labelCls}>{tt("entry.date")}</label>
          <input className={inputCls} type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
        </div>
        <div>
          <label className={labelCls}>{tt("entry.category")}</label>
          <select className={inputCls} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
            {CATEGORY_OPTIONS.map((c) => (
              <option key={c}>{tt(CAT_LABEL_KEYS[c] ?? "entry.catOther")}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls}>{tt("entry.name")}</label>
          <input className={inputCls} value={f.item} onChange={(e) => setF({ ...f, item: e.target.value })} placeholder={tt("entry.itemPh")} />
        </div>
        <div>
          <label className={labelCls}>{tt("entry.amount")}</label>
          <input className={inputCls} type="number" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder="66" />
        </div>
      </div>
      <div className="text-[11px] text-muted-foreground">
        {tt("entry.incomeHint")}
      </div>
      {err && <div className="text-xs text-red-600 dark:text-red-400">{err}</div>}
      <Button size="sm" onClick={() => void submit()} disabled={!f.item || !f.amount}>
        <Plus className="w-3.5 h-3.5" /> {tt("entry.addOne")}
      </Button>
    </div>
  );
}

/** {tt("entry.nlLedger")}：规则解析秒回，复杂句自动升级 AI；成功直接入账。 */function NlForm({ onDone }: { onDone: () => void }) {
  const { toast } = useToast();
  const { t: tt } = useI18n();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const samples = [tt("entry.sample1"), tt("entry.sample2"), tt("entry.sample3")];

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
        tt("entry.recorded", { cat: t.category, amt: fmtMoney(t.amount, true), item: t.item, date: t.date }) + (r.source === "ai" ? tt("entry.aiSuffix") : ""),
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
        {tt("entry.nlLedger")}
      </div>
      <div className="flex gap-2">
        <input
          className={inputCls}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
          placeholder={tt("entry.nlPh")}
        />
        <Button size="sm" onClick={() => void submit()} disabled={busy || !text.trim()}>
          {busy ? tt("entry.parsing") : tt("entry.addOne")}
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
  const { t: tt } = useI18n();
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
      toast(r.failed.length ? tt("entry.importPartial", { n: r.imported, m: r.failed.length }) : tt("entry.importOk", { n: r.imported }), r.failed.length ? "error" : "ok");
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
      .catch(() => toast(tt("entry.fileReadFail"), "error"));
  };

  return (
    <div className="mb-3 rounded-xl border border-border/70 p-3">
      <div className="text-xs font-medium mb-1.5">{tt("entry.importCsv")}</div>
      <div className="text-[11px] text-muted-foreground mb-2">
        {tt("entry.importDesc")}
      </div>
      <textarea
        className={`${inputCls} min-h-16`}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder={tt("entry.csvPh")}
      />
      <div className="mt-2 flex gap-2">
        <Button size="sm" variant="outline" onClick={() => void parse()} disabled={busy || !content.trim()}>
          {busy ? tt("entry.parsing") : tt("entry.preview")}
        </Button>
        <label className="inline-flex items-center text-xs text-muted-foreground cursor-pointer hover:text-primary">
          {tt("entry.upload")}
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
            {tt("entry.recognized", { n: parsed.total })}
            {parsed.skipped > 0 && <span className="text-muted-foreground">{tt("entry.skipped", { n: parsed.skipped })}</span>}
          </div>
          <div className="overflow-x-auto scroll-thin">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground text-left">
                  <th className="py-1 pr-3">{tt("entry.date")}</th>
                  <th className="py-1 pr-3">{tt("entry.name")}</th>
                  <th className="py-1 pr-3">{tt("entry.category")}</th>
                  <th className="py-1 text-right">{tt("entry.amount")}</th>
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
              {importing ? tt("entry.importing") : tt("entry.confirmImport", { n: parsed.total })}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setParsed(null)}>
              {tt("entry.cancel")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function DebtForm({ onDone }: { onDone: () => void }) {
  const { t: tt } = useI18n();
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
          <label className={labelCls}>{tt("entry.name")}</label>
          <input className={inputCls} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={tt("entry.debtNamePh")} />
        </div>
        <div>
          <label className={labelCls}>{tt("entry.monthlyPay")}</label>
          <input className={inputCls} type="number" value={f.monthly} onChange={(e) => setF({ ...f, monthly: e.target.value })} placeholder="6800" />
        </div>
        <div>
          <label className={labelCls}>{tt("entry.balance")}</label>
          <input className={inputCls} type="number" value={f.balance} onChange={(e) => setF({ ...f, balance: e.target.value })} placeholder="1280000" />
        </div>
        <div>
          <label className={labelCls}>{tt("entry.rate")}</label>
          <input className={inputCls} type="number" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} placeholder="3.45" />
        </div>
        <div>
          <label className={labelCls}>{tt("entry.dueDay")}</label>
          <input className={inputCls} type="number" min="1" max="31" value={f.dueDay} onChange={(e) => setF({ ...f, dueDay: e.target.value })} placeholder="15" />
        </div>
      </div>
      {err && <div className="text-xs text-red-600 dark:text-red-400">{err}</div>}
      <Button size="sm" onClick={() => void submit()} disabled={!f.name}>
        <Plus className="w-3.5 h-3.5" /> {tt("entry.addDebt")}
      </Button>
    </div>
  );
}

function SubscriptionForm({ onDone }: { onDone: () => void }) {
  const { t: tt } = useI18n();
  const [f, setF] = useState({ name: "", monthly: "", dueDay: "", note: "" });
  const [err, setErr] = useState("");

  const submit = async () => {
    setErr("");
    try {
      await api("/api/subscriptions", {
        method: "POST",
        body: JSON.stringify({
          name: f.name.trim(),
          monthly: Number(f.monthly),
          due_day: f.dueDay.trim(),
          note: f.note.trim(),
        }),
      });
      setF({ name: "", monthly: "", dueDay: "", note: "" });
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="space-y-2.5">
      <div className="grid grid-cols-2 gap-2.5">
        <div>
          <label className={labelCls}>{tt("entry.name")}</label>
          <input className={inputCls} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={tt("entry.subNamePh")} />
        </div>
        <div>
          <label className={labelCls}>{tt("entry.monthlyCost")}</label>
          <input className={inputCls} type="number" value={f.monthly} onChange={(e) => setF({ ...f, monthly: e.target.value })} placeholder="68" />
        </div>
        <div>
          <label className={labelCls}>{tt("entry.dueDay")}</label>
          <input className={inputCls} type="number" min="1" max="31" value={f.dueDay} onChange={(e) => setF({ ...f, dueDay: e.target.value })} placeholder="5" />
        </div>
        <div>
          <label className={labelCls}>{tt("entry.note")}</label>
          <input className={inputCls} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder={tt("entry.notePh")} />
        </div>
      </div>
      {err && <div className="text-xs text-red-600 dark:text-red-400">{err}</div>}
      <Button size="sm" onClick={() => void submit()} disabled={!f.name || !f.monthly}>
        <Plus className="w-3.5 h-3.5" /> {tt("entry.addSubscription")}
      </Button>
    </div>
  );
}

type ListTab = "transactions" | "debts" | "subscriptions" | "goals";
type Panel = "expense" | "income" | "import" | "position" | "debt" | "subscription" | "goal" | null;

export function EntryView() {
  const { t: tt } = useI18n();
  const { dashboard } = appStore.useApp();
  const [tab, setTab] = useState<ListTab>("transactions");
  const [panel, setPanel] = useState<Panel>(null);
  const [txQuery, setTxQuery] = useState("");

  const actions: { id: Panel; label: string; icon: React.ReactNode }[] = [
    { id: "expense", label: tt("entry.actionExpense"), icon: <Plus className="w-3.5 h-3.5" /> },
    { id: "income", label: tt("entry.actionIncome"), icon: <Wallet className="w-3.5 h-3.5" /> },
    { id: "import", label: tt("entry.actionImport"), icon: <FileUp className="w-3.5 h-3.5" /> },
    { id: "position", label: tt("entry.actionPositions"), icon: <Sparkles className="w-3.5 h-3.5" /> },
    { id: "debt", label: tt("entry.actionDebt"), icon: <Landmark className="w-3.5 h-3.5" /> },
    { id: "subscription", label: tt("entry.actionSubscription"), icon: <Repeat className="w-3.5 h-3.5" /> },
    { id: "goal", label: tt("entry.actionGoal"), icon: <Target className="w-3.5 h-3.5" /> },
  ];

  const tabs: { id: ListTab; label: string; count?: number }[] = [
    { id: "transactions", label: tt("entry.tabTransactions"), count: dashboard?.transactions.length },
    { id: "debts", label: tt("entry.tabDebts"), count: dashboard?.debts.items.length },
    { id: "subscriptions", label: tt("entry.tabSubscriptions"), count: dashboard?.subscriptions.items.length },
    { id: "goals", label: tt("entry.tabGoals"), count: dashboard?.goals.length },
  ];

  // 流水本地搜索：名称/分类/日期 任一命中
  const txQueryL = txQuery.trim().toLowerCase();
  const txRows = (dashboard?.transactions ?? []).filter((t) => {
    if (!txQueryL) return true;
    return (
      t.item.toLowerCase().includes(txQueryL) ||
      t.category.toLowerCase().includes(txQueryL) ||
      t.date.includes(txQueryL)
    );
  });

  const openPanel = (id: Panel) => setPanel((cur) => (cur === id ? null : id));

  return (
    <div className="space-y-3">
      {/* 主入口：{tt("entry.nlLedger")}，永远在最上面 */}
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
        <Section title={tt("entry.sectionExpense")}>
          <TransactionForm defaultCategory="餐饮" onDone={() => appStore.bump()} />
        </Section>
      )}
      {panel === "income" && (
        <Section title={tt("entry.sectionIncome")}>
          <TransactionForm defaultCategory="收入" onDone={() => appStore.bump()} />
        </Section>
      )}
      {panel === "import" && <ImportPanel onDone={() => appStore.bump()} />}
      {panel === "position" && (
        <Section title={tt("entry.sectionPosition")} badge={<Badge variant="muted">{tt("entry.priceHint")}</Badge>}>
          <PositionForm onDone={() => appStore.bump()} />
        </Section>
      )}
      {panel === "debt" && (
        <Section title={tt("entry.sectionDebt")}>
          <DebtForm onDone={() => appStore.bump()} />
        </Section>
      )}
      {panel === "subscription" && (
        <Section title={tt("entry.sectionSubscription")}>
          <SubscriptionForm onDone={() => appStore.bump()} />
        </Section>
      )}
      {panel === "goal" && (
        <Section title={tt("entry.sectionGoal")}>
          <GoalsPanel onDone={() => appStore.bump()} />
        </Section>
      )}

      {/* 列表管理：流水 + 负债/订阅/目标（5 页签下唯一的账户管理入口；持仓管理在持仓页） */}
      <Section
        title={tt("entry.myLedger")}
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
            <div>
              {/* 流水搜索：本地过滤，不打接口 */}
              <div className="relative mb-2">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input
                  className="w-full rounded-lg border border-input bg-background pl-8 pr-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  value={txQuery}
                  onChange={(e) => setTxQuery(e.target.value)}
                  placeholder={tt("entry.searchPh")}
                />
              </div>
              <div className="max-h-80 overflow-y-auto scroll-thin">
                {(() => {
                  const shown = [...txRows].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 200);
                  const groups: { date: string; rows: typeof shown }[] = [];
                  for (const t of shown) {
                    const last = groups[groups.length - 1];
                    if (last && last.date === t.date) last.rows.push(t);
                    else groups.push({ date: t.date, rows: [t] });
                  }
                  return groups.map((g) => {
                    const dayTotal = g.rows.reduce((s, t) => s + t.amount, 0);
                    return (
                      <div key={g.date}>
                        <div className="sticky top-0 flex items-center justify-between border-b border-border/60 bg-card py-1 text-[11px] text-muted-foreground">
                          <span className="tabular-nums">{g.date}</span>
                          <span className="tabular-nums">{dayTotal > 0 ? "+" : ""}{fmtMoney(dayTotal, true)}</span>
                        </div>
                        {g.rows.map((t) => (
                          <div key={t.id} className="flex items-center justify-between py-1.5 text-sm">
                            <span className="min-w-0">
                              <span className="truncate">{t.item}</span>
                              <span className="text-muted-foreground text-xs ml-2">{t.category}</span>
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
                                aria-label={tt("entry.deleteItem", { name: t.item })}
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </span>
                          </div>
                        ))}
                      </div>
                    );
                  });
                })()}
                {txRows.length === 0 && (
                  <div className="py-4 text-center text-xs text-muted-foreground">{tt("entry.noMatchTx", { q: txQuery })}</div>
                )}
                {txQueryL === "" && dashboard.transactions.length > 200 && (
                  <div className="py-2 text-center text-xs text-muted-foreground">
                    {tt("entry.txCount", { n: dashboard.transactions.length })}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="py-6 text-center text-sm text-muted-foreground">
              {tt("entry.noTx")}
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
                    <span className="tabular-nums text-muted-foreground">{tt("entry.perMonth", { v: fmtMoney(d.monthly) })}</span>
                    <button
                      className="text-muted-foreground hover:text-red-600"
                      onClick={() => {
                        void api(`/api/debts/${encodeURIComponent(d.name)}`, { method: "DELETE" }).then(() => appStore.bump());
                      }}
                      aria-label={tt("entry.deleteItem", { name: d.name })}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="py-6 text-center text-sm text-muted-foreground">{tt("entry.noDebts")}</div>
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
                      {s.due_day && <span className="text-xs text-muted-foreground ml-1.5">{tt("entry.dueDaySuffix", { d: s.due_day })}</span>}
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="tabular-nums text-muted-foreground">{tt("entry.perMonth", { v: fmtMoney(s.monthly) })}</span>
                      <button
                        className="text-muted-foreground hover:text-red-600"
                        onClick={() => {
                          void api(`/api/subscriptions/${encodeURIComponent(s.name)}`, { method: "DELETE" }).then(() => appStore.bump());
                        }}
                        aria-label={tt("entry.deleteSub", { name: s.name })}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="py-6 text-center text-sm text-muted-foreground">{tt("entry.noSubs")}</div>
            )}
            <div className="mt-3 text-[11px] text-muted-foreground">
              {tt("entry.subTotal", { v: fmtMoney(dashboard?.subscriptions.monthly_total ?? 0) })}
            </div>
          </div>
        )}
        {tab === "goals" && (
          <div>
            <GoalsList goals={dashboard?.goals ?? []} onDone={() => appStore.bump()} />
          </div>
        )}
      </Section>
    </div>
  );
}
