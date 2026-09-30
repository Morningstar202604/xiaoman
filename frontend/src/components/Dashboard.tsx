import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, HeartPulse, LineChart, MessageSquare, NotebookPen, RefreshCw, Send } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton, DashboardSkeleton } from "@/components/ui/skeleton";
import { useEChart, usePalette, axisLabelColor } from "@/lib/charts";
import { useTheme } from "@/lib/theme";
import { useI18n } from "@/lib/i18n";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast";
import { store } from "@/lib/store";
import { fmtMoney, fmtPct, fmtMonth, getMoneyLocale, pnlClass } from "@/lib/format";
import { PositionsTable } from "@/components/PositionsTable";
import { HealthCheckDialog } from "@/components/HealthCheckDialog";
import { IndicesStrip } from "@/components/IndicesStrip";
import type { DashboardData, TrendMonth, BudgetUsage } from "@/lib/types";

/** 置顶快捷记账条：一句话记账（AI 解析 + 规则兜底），总览常驻 */
function QuickLedgerBar() {
  const { t: tr } = useI18n();
  const { toast } = useToast();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const v = text.trim();
    if (!v || busy) return;
    setBusy(true);
    try {
      const r = await api<{ source: string; transaction: { item: string; category: string; amount: number } }>("/api/nl-add", {
        method: "POST",
        body: JSON.stringify({ text: v }),
      });
      setText("");
      toast(tr("dash.ledgerSaved", { c: r.transaction.category, v: fmtMoney(r.transaction.amount) }), "ok");
      void store.refreshDashboard();
      store.bump();
    } catch (e) {
      toast(tr("dash.ledgerFail", { e: e instanceof Error ? e.message : String(e) }), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex items-center gap-2 rounded-[var(--radius)] border border-border bg-card px-3 py-2.5">
      <NotebookPen className="w-4 h-4 text-primary shrink-0" />
      <input
        className="min-w-0 flex-1 bg-transparent text-sm focus:outline-none placeholder:text-muted-foreground"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
        }}
        placeholder={tr("dash.quickLedgerPh")}
        maxLength={80}
        aria-label={tr("dash.quickLedger")}
      />
      {busy ? (
        <span className="shrink-0 text-xs text-muted-foreground">{tr("dash.ledgerParsing")}</span>
      ) : (
        <Button size="sm" disabled={!text.trim()} onClick={() => void submit()}>
          <Send className="w-3.5 h-3.5" /> {tr("dash.quickLedger")}
        </Button>
      )}
    </div>
  );
}

/** 持仓速览：Top5 非现金持仓（市值 + 今日盈亏 + 累计盈亏） */
function TopHoldings({ dashboard }: { dashboard: DashboardData }) {
  const { t: tr } = useI18n();
  const rows = dashboard.positions.filter((p) => p.kind !== "现金").slice(0, 5);
  if (!rows.length) return null;
  // 行情来源醒目标注：非东财实时价（快照/降级）时显示「离线估值」徽标
  const src = dashboard.source.quotes ?? "";
  const isSnapshot = src.includes("快照");
  return (
    <Card className="p-[var(--card-pad)]">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium">{tr("dash.topHoldings")}</span>
        <span className="flex items-center gap-2">
          {isSnapshot && (
            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium leading-none text-amber-700">
              {tr("dash.offlineValuation")}
            </span>
          )}
          <span className="text-[11px] text-muted-foreground">
            {tr("dash.todayPnl")} · {tr("dash.totalPnl")} · {tr("dash.holdingsValue")}
          </span>
        </span>
      </div>
      <ul className="space-y-2">
        {rows.map((p) => {
          const day = dashboard.today_pnl.items[p.symbol];
          return (
            <li key={p.symbol} className="flex items-center justify-between gap-2 text-sm">
              <span className="min-w-0 truncate">
                {p.name}
                <span className="ml-1.5 text-xs text-muted-foreground">{p.kind}</span>
              </span>
              <span className="flex shrink-0 items-center gap-2.5 tabular-nums">
                <span className={pnlClass(day)}>{day != null ? fmtMoney(day, true, true) : "—"}</span>
                <span className={`w-16 text-right ${pnlClass(p.pnl)}`}>{fmtMoney(p.pnl, true, true)}</span>
                <span className="w-20 text-right text-muted-foreground">{fmtMoney(p.market_value, false, true)}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function StatCell({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "up" | "down" | "plain";
}) {
  const color =
    tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-foreground";
  return (
    /* 账本抬头栏：靠竖线分隔，不用独立卡片；金额与说明分两行，永不截断 */
    <div className="min-w-0 px-3 py-2 first:pl-0 sm:px-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`mt-1 text-xl font-bold tabular-nums num-in leading-tight ${color}`}>{value}</div>
      {sub ? <div className="mt-0.5 text-xs text-muted-foreground leading-snug">{sub}</div> : null}
    </div>
  );
}

function RiskBanner({ flags }: { flags: DashboardData["flags"] }) {
  const { t: tr } = useI18n();
  /* 摘掉的配饰：原来这里是一只和统计卡/待扣提醒同款的白色圆角卡。
     4 项风险自己会说话，不需要第三个同款盒子——改成一段带竖线锚的列表。 */
  if (!flags.length) {
    return (
      <div className="flex items-center gap-2 border-l-2 border-emerald-500/60 pl-3 py-1 text-sm">
        <CheckCircle2 className="w-4 h-4 text-success shrink-0" />
        <span className="text-success text-balance">{tr("dash.noRisk")}</span>
      </div>
    );
  }
  return (
    <div className="border-l-2 border-amber-500/70 pl-3 py-1">
      <div className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
        <AlertTriangle className="w-4 h-4 shrink-0" />
        {tr("dash.riskCount", { n: flags.length })}
      </div>
      <ul className="mt-1.5 space-y-1">
        {flags.map((f, i) => (
          <li key={i} className="flex gap-2 text-sm text-foreground/85">
            <span className="mt-1.5 w-1 h-1 rounded-full bg-amber-500 shrink-0" />
            <span className="text-balance">{f.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 近期待扣提醒：今天到期（红）与 3 天内到期（黄）的负债与订阅。 */
function DueSoonStrip({ dashboard }: { dashboard: DashboardData }) {
  const { t: tr } = useI18n();
  const today = new Date();
  const day = today.getDate();
  const monthLabel = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
  const items = [
    ...dashboard.debts.items.map((d) => ({ name: d.name, amount: d.monthly, due: d.due_day ?? "", kind: "还款" as const })),
    ...dashboard.subscriptions.items.map((s) => ({ name: s.name, amount: s.monthly, due: s.due_day ?? "", kind: "扣款" as const })),
  ].filter((i) => i.due && /^\d{1,2}$/.test(i.due));

  const dueToday = items.filter((i) => Number(i.due) === day);
  // 跨月：本月已过号的扣款日滚动到下月，按"距下次扣款天数"计算（含月末→月初）
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const daysUntil = (due: number) => (due >= day ? due - day : daysInMonth - day + due);
  const dueSoon = items.filter((i) => {
    const d = daysUntil(Number(i.due));
    return d > 0 && d <= 3;
  });
  if (dueToday.length === 0 && dueSoon.length === 0) return null;
  const totalToday = dueToday.reduce((s, i) => s + i.amount, 0);
  const totalSoon = dueSoon.reduce((s, i) => s + i.amount, 0);

  return (
    /* 待扣提醒：账本的一行行条目，卡中卡去掉，改用左侧色条区分紧急度 */
    <div className="rounded-[var(--radius)] border border-border bg-card px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-sm font-medium mb-1.5">
        <span className="w-1.5 h-1.5 rounded-full bg-red-500 inline-block" />
        {tr("dash.upcoming", { m: monthLabel })}
      </div>
      <div className="space-y-1.5">
        {dueToday.length > 0 && (
          <div className="border-l-2 border-red-500/70 pl-2.5">
            <div className="text-xs font-medium text-red-600 dark:text-red-400">{tr("dash.dueToday", { v: fmtMoney(totalToday, false) })}</div>
            <div className="mt-0.5 flex gap-x-3 gap-y-0.5 flex-wrap text-xs text-muted-foreground">
              {dueToday.map((i) => (
                <span key={i.name} className="tabular-nums">
                  {i.name} {fmtMoney(i.amount, false)}（{tr("dash.dueOn", { d: i.due })} {i.kind === "还款" ? tr("dash.repay") : tr("dash.charge")}）
                </span>
              ))}
            </div>
          </div>
        )}
        {dueSoon.length > 0 && (
          <div className="border-l-2 border-amber-500/70 pl-2.5">
            <div className="text-xs font-medium text-amber-600 dark:text-amber-400">{tr("dash.dueSoon", { v: fmtMoney(totalSoon, false) })}</div>
            <div className="mt-0.5 flex gap-x-3 gap-y-0.5 flex-wrap text-xs text-muted-foreground">
              {dueSoon.map((i) => (
                <span key={i.name} className="tabular-nums">
                  {i.name} {fmtMoney(i.amount, false)}（{Number(i.due) < day ? tr("dash.nextMonth") : ""}{tr("dash.dueOn", { d: i.due })} {i.kind === "还款" ? tr("dash.repay") : tr("dash.charge")}）
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** 预算超支 / 目标临期：总览提醒条（有内容才显示，不占首屏高度） */
function AlertLine({ budget, goals }: { budget: BudgetUsage | null; goals: DashboardData["goals"] }) {
  const { t: tr } = useI18n();
  const today = new Date();
  const monthLabel = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
  const overBudget = budget && budget.usage.total_budget > 0 && budget.usage.total_pct >= 100;
  const expiring = goals.filter((g) => !g.done && g.deadline && g.deadline.startsWith(monthLabel));
  if (!overBudget && expiring.length === 0) return null;
  return (
    <div className="rounded-[var(--radius)] border border-border bg-card px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-sm font-medium mb-1.5">
        <span className="w-1.5 h-1.5 rounded-full bg-amber-500 inline-block" />
        {tr("dash.alerts")}
      </div>
      <div className="space-y-1.5">
        {overBudget && (
          <div className="border-l-2 border-red-500/70 pl-2.5 text-xs">
            <span className="font-medium text-red-600 dark:text-red-400">
              {tr("dash.budgetOver", { m: budget!.month, p: budget!.usage.total_pct })}
            </span>
            <span className="ml-2 text-muted-foreground tabular-nums">
              {fmtMoney(budget!.usage.total_spent, false)} / {fmtMoney(budget!.usage.total_budget, false)}
            </span>
          </div>
        )}
        {expiring.map((g) => (
          <div key={g.name} className="border-l-2 border-amber-500/70 pl-2.5 text-xs">
            <span className="text-amber-600 dark:text-amber-400">{tr("dash.goalDue", { n: g.name })}</span>
            <span className="ml-2 text-muted-foreground tabular-nums">
              {fmtMoney(g.saved, false)} / {fmtMoney(g.target, false)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function AssetPie({ data }: { data: DashboardData }) {
  const ref = useRef<HTMLDivElement>(null);
  const palette = usePalette();
  const { resolved } = useTheme();
  const option = useMemo(() => {
    const items = data.concentration.by_asset.filter((a) => a.pct > 0.5);
    return {
      tooltip: { trigger: "item", triggerOn: "click", renderMode: "richText", confine: true, formatter: `{b}\n${getMoneyLocale() === "zh" ? "占比" : "Share"} {d}%` },
      legend: {
        type: "scroll",
        bottom: 0,
        textStyle: { fontSize: 11, color: axisLabelColor(resolved) },
        icon: "circle",
        itemWidth: 8,
        itemHeight: 8,
      },
      series: [
        {
          type: "pie",
          radius: ["42%", "68%"],
          center: ["50%", "44%"],
          avoidLabelOverlap: true,
          itemStyle: { borderRadius: 4, borderColor: "transparent", borderWidth: 2 },
          label: { show: false },
          emphasis: { label: { show: true, fontSize: 12, fontWeight: 600, color: axisLabelColor(resolved) } },
          data: items.map((a, i) => ({ name: a.name, value: a.pct, itemStyle: { color: palette[i % palette.length] } })),
        },
      ],
      grid: { containLabel: true },
    };
  }, [data, palette, resolved]);
  useEChart(ref, option, [option]);
  return <div ref={ref} className="h-52 w-full" />;
}

function ExpenseBar({ data }: { data: DashboardData }) {
  const ref = useRef<HTMLDivElement>(null);
  const palette = usePalette();
  const { resolved } = useTheme();
  const option = useMemo(() => {
    const cats = data.cashflow.by_category.slice(0, 6);
    return {
      tooltip: { trigger: "axis", triggerOn: "click", renderMode: "richText", confine: true, axisPointer: { type: "shadow" } },
      grid: { left: 8, right: 12, top: 14, bottom: 4, containLabel: true },
      xAxis: {
        type: "value",
        axisLabel: { fontSize: 10, color: axisLabelColor(resolved), formatter: (v: number) => (v >= 10000 ? `${(v / 10000).toFixed(1)}${getMoneyLocale() === "zh" ? "万" : "k"}` : `${v}`) },
        splitLine: { lineStyle: { type: "dashed", color: "hsl(var(--border))" } },
      },
      yAxis: { type: "category", data: cats.map((c) => c.category), axisLabel: { fontSize: 11, color: axisLabelColor(resolved) } },
      series: [
        {
          type: "bar",
          data: cats.map((c, i) => ({
            value: c.amount,
            itemStyle: { color: palette[(i + 2) % palette.length], borderRadius: [0, 4, 4, 0] },
          })),
          barWidth: 14,
          label: { show: true, position: "right", fontSize: 10, color: axisLabelColor(resolved), formatter: (p: { value: number }) => fmtMoney(p.value) },
        },
      ],
    };
  }, [data, palette, resolved]);
  useEChart(ref, option, [option]);
  return <div ref={ref} className="h-52 w-full" />;
}

/** 月度收支趋势（柱状：收入 / 支出，折线：结余） */
function TrendChart({ trend }: { trend: TrendMonth[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const { resolved } = useTheme();
  const palette = usePalette();
  const option = useMemo(() => {
    const months = trend.map((t) => fmtMonth(t.month));
    return {
      tooltip: { trigger: "axis", triggerOn: "click", renderMode: "richText", confine: true },
      legend: { top: 0, textStyle: { fontSize: 11, color: axisLabelColor(resolved) } },
      grid: { left: 8, right: 8, top: 30, bottom: 4, containLabel: true },
      xAxis: { type: "category", data: months, axisLabel: { fontSize: 10, color: axisLabelColor(resolved) } },
      yAxis: {
        type: "value",
        axisLabel: { fontSize: 10, color: axisLabelColor(resolved), formatter: (v: number) => (v >= 10000 ? `${(v / 10000).toFixed(1)}${getMoneyLocale() === "zh" ? "万" : "k"}` : `${v}`) },
        splitLine: { lineStyle: { type: "dashed", color: "hsl(var(--border))" } },
      },
      series: [
        {
          name: getMoneyLocale() === "zh" ? "收入" : "Income",
          type: "bar",
          data: trend.map((t) => t.income),
          itemStyle: { color: palette[2], borderRadius: [4, 4, 0, 0] },
          barWidth: 12,
        },
        {
          name: getMoneyLocale() === "zh" ? "支出" : "Expense",
          type: "bar",
          data: trend.map((t) => t.expense),
          itemStyle: { color: palette[5], borderRadius: [4, 4, 0, 0] },
          barWidth: 12,
        },
        {
          name: getMoneyLocale() === "zh" ? "结余" : "Net",
          type: "line",
          data: trend.map((t) => t.net),
          symbolSize: 5,
          itemStyle: { color: palette[0] },
          lineStyle: { width: 2 },
        },
      ],
    };
  }, [trend, resolved, palette]);
  useEChart(ref, option, [option]);
  return <div ref={ref} className="h-56 w-full" />;
}

function EmergencyCard({ data }: { data: DashboardData }) {
  const { t: tr } = useI18n();
  const em = data.emergency;
  const pct = em.has_data && em.target_months ? Math.min(100, (em.months_covered / em.target_months) * 100) : 0;
  return (
    <Card className="p-[var(--card-pad)]">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">{tr("dash.emergency")}</div>
        {em.has_data ? (
          <Badge variant={em.ok ? "ok" : "warn"}>{em.ok ? tr("dash.onTrack") : tr("dash.short")}</Badge>
        ) : (
          <Badge variant="muted">{tr("dash.noData")}</Badge>
        )}
      </div>
      <div className="mt-3 flex items-baseline gap-1">
        <span className="text-2xl font-bold tabular-nums">{em.has_data ? em.months_covered : "—"}</span>
        <span className="text-sm text-muted-foreground">
          {em.has_data ? getMoneyLocale() === "zh" ? `个月（目标 ${em.target_months} 个月）` : `mo (target ${em.target_months} mo)` : tr("dash.estUnknown")}
        </span>
      </div>
      <div className="mt-2 h-2 rounded-full bg-muted overflow-hidden">
        <div
          className={`h-full rounded-full ${em.has_data && !em.ok ? "bg-amber-500" : "bg-success"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-2 text-xs text-muted-foreground">
        {tr("dash.cashVsEssential", { c: fmtMoney(em.cash), e: fmtMoney(em.essential_monthly) })}
      </div>
    </Card>
  );
}

/** 本月预算：总预算进度 + 剩余日均 + 分类进度；未设置预算时不占位
 *  数据由 Dashboard 主组件统一拉取（避免双请求 /api/budgets），本组件只渲染 */
function BudgetCard({ budget }: { budget: BudgetUsage | null }) {
  const { t: tr } = useI18n();
  const { bootstrap } = store.useApp();
  const compact = bootstrap?.settings.compact_numbers === "on";

  if (!budget || budget.usage.total_budget <= 0) return null;
  const u = budget.usage;
  const barCls = u.over ? "bg-red-500" : u.total_pct >= 80 ? "bg-amber-500" : "bg-success";
  return (
    <Card className="p-[var(--card-pad)]">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">{tr("dash.budget", { m: budget.month })}</div>
        <Badge variant={u.over ? "warn" : "ok"}>{u.over ? tr("dash.over") : u.total_pct >= 80 ? tr("dash.nearCap") : tr("dash.onPace")}</Badge>
      </div>
      <div className="mt-3 flex items-baseline gap-1">
        <span className="text-2xl font-bold tabular-nums">{fmtMoney(u.total_spent, false, compact)}</span>
        <span className="text-sm text-muted-foreground">/ {fmtMoney(u.total_budget, false, compact)}（{u.total_pct}%）</span>
      </div>
      <div className="mt-2 h-2 rounded-full bg-muted overflow-hidden">
        <div className={`h-full rounded-full ${barCls}`} style={{ width: `${Math.min(100, u.total_pct)}%` }} />
      </div>
      <div className="mt-2 text-xs text-muted-foreground">
        {u.over ? `${tr("dash.overBy")} ${fmtMoney(-u.left, false, compact)}` : `${tr("dash.left")} ${fmtMoney(u.left, false, compact)}`}
        {` · ${tr("dash.daily")} `}
        {u.over ? `${tr("dash.overBy")} ${fmtMoney(-u.left_daily, false, compact)}` : `${tr("dash.available")} ${fmtMoney(u.left_daily, false, compact)}`}
      </div>
      {u.categories.filter((c) => c.budget > 0).length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {u.categories.filter((c) => c.budget > 0).slice(0, 4).map((c) => (
            <li key={c.category} className="text-xs">
              <div className="flex justify-between text-muted-foreground">
                <span>{c.category}</span>
                <span className={c.over ? "text-red-500 font-medium" : ""}>
                  {fmtMoney(c.spent, false, compact)} / {fmtMoney(c.budget, false, compact)}
                  {c.over ? ` ${tr("dash.over")}` : ""}
                </span>
              </div>
              <div className="mt-0.5 h-1.5 rounded-full bg-muted overflow-hidden">
                <div
                  className={`h-full rounded-full ${c.over ? "bg-red-500" : c.pct >= 80 ? "bg-amber-500" : "bg-success"}`}
                  style={{ width: `${Math.min(100, c.pct)}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** 目标卡：前 3 个目标进度 + 财务体检入口；无目标时只留体检按钮 */
function GoalsCard({ goals, net }: { goals: DashboardData["goals"]; net: number }) {
  const { t: tr } = useI18n();
  const [healthOpen, setHealthOpen] = useState(false);
  const top = goals.filter((g) => !g.done).slice(0, 3);

  return (
    <Card className="p-[var(--card-pad)]">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">{tr("dash.goals")}</div>
        <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => setHealthOpen(true)}>
          <HeartPulse className="w-3.5 h-3.5" /> {tr("dash.healthCheck")}
        </Button>
      </div>
      {top.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          {goals.length > 0
            ? tr("dash.allGoalsDone")
            : tr("dash.noGoals")}
        </p>
      ) : (
        <div className="mt-3 space-y-2.5">
          {top.map((g) => (
            <div key={g.name}>
              <div className="flex items-center justify-between text-xs">
                <span className="truncate pr-2">{g.name}</span>
                <span className="tabular-nums text-muted-foreground shrink-0">{g.pct}%</span>
              </div>
              <div className="mt-1 h-1.5 w-full rounded-full bg-muted overflow-hidden">
                <div
                  className={`h-full rounded-full ${g.pct >= 100 ? "bg-success" : g.pct >= 50 ? "bg-primary" : "bg-amber-500"}`}
                  style={{ width: `${Math.min(100, g.pct)}%` }}
                />
              </div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                {fmtMoney(g.saved, false)} / {fmtMoney(g.target, false)}
                {g.monthly_suggest != null && ` · ${tr("dash.suggestMonthly")} ${fmtMoney(g.monthly_suggest, false)}`}
                {g.gap > 0 && net > 0 && ` · ${tr("dash.monthsToGoal", { n: Math.max(1, Math.ceil(g.gap / net)) })}`}
              </div>
            </div>
          ))}
        </div>
      )}
      <HealthCheckDialog open={healthOpen} onOpenChange={setHealthOpen} />
    </Card>
  );
}

export function Dashboard({
  onGoLedger,
  onGoMarket,
  onGoChat,
}: {
  onGoLedger?: () => void;
  onGoMarket?: () => void;
  onGoChat?: () => void;
} = {}) {
  const { dashboard, loading, bootstrap, refreshTick } = store.useApp();
  const { t: tr } = useI18n();
  const [trend, setTrend] = useState<TrendMonth[] | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const compact = (bootstrap?.settings.compact_numbers ?? "on") === "on";
  const [budget, setBudget] = useState<BudgetUsage | null>(null);

  useEffect(() => {
    let alive = true;
    api<BudgetUsage>("/api/budgets")
      .then((r) => alive && setBudget(r))
      .catch(() => alive && setBudget(null));
    return () => {
      alive = false;
    };
  }, [refreshTick]);

  useEffect(() => {
    let alive = true;
    api<{ months: TrendMonth[] }>("/api/trend?months=6")
      .then((r) => alive && setTrend(r.months))
      .catch(() => alive && setTrend([]));
    return () => {
      alive = false;
    };
  }, [refreshTick]);

  useEffect(() => {
    const el = detailsRef.current;
    if (!el) return;
    const onToggle = () => setDetailsOpen(el.open);
    setDetailsOpen(el.open); // 首次挂载即同步（元素可能在骨架屏后才渲染）
    el.addEventListener("toggle", onToggle);
    return () => el.removeEventListener("toggle", onToggle);
  }, [dashboard]);

  if (loading && !dashboard) {
    return <DashboardSkeleton />;
  }
  if (!dashboard) {
    return (
      <div className="p-8 text-center">
        <p className="text-sm text-muted-foreground mb-3">{tr("dash.loadFail")}</p>
        <Button variant="outline" size="sm" onClick={() => store.refreshDashboard()}>
          <RefreshCw className="w-4 h-4" /> {tr("dash.retry")}
        </Button>
      </div>
    );
  }

  const t = dashboard.totals;
  const cf = dashboard.cashflow;
  const cash = dashboard.positions.filter((p) => p.kind === "现金").reduce((s, p) => s + p.cost, 0);
  const holdingsValue = t.total_market_value - cash;
  const todayPnl = dashboard.today_pnl.total;

  // 空数据降级为引导：不渲染零值统计卡与风险横幅（零值 + 误报警是新用户劝退组合）。
  // 新用户首启即此态：一句话记账条 + 开始引导 + 大盘，聊天式起步。
  if (dashboard.positions.length === 0 && dashboard.transactions.length === 0) {
    return (
      <div className="space-y-3">
        <QuickLedgerBar />
        <Card className="p-6 text-center">
          <div className="text-base font-semibold">{tr("dash.emptyTitle")}</div>
          <p className="mt-1.5 text-sm text-muted-foreground text-balance">
            {tr("dash.emptyDesc")}
          </p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <Button size="sm" onClick={() => onGoLedger?.()}>
              <NotebookPen className="w-4 h-4" /> {tr("dash.goLedger")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => onGoMarket?.()}>
              <LineChart className="w-4 h-4" /> {tr("dash.emptyHoldingBtn")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => onGoChat?.()}>
              <MessageSquare className="w-4 h-4" /> {tr("dash.emptyAskBtn")}
            </Button>
          </div>
        </Card>
        <IndicesStrip indices={dashboard.indices} />
        <p className="px-2 text-xs text-muted-foreground">
          {tr("dash.demoHint")}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* 示例数据横幅：首启种入的示例数据必须明说，避免被当成自己的真实数据 */}
      {dashboard.source.seeded && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius)] border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          <span>{tr("dash.demoBanner")}</span>
          <Button variant="outline" size="sm" className="h-6 px-2" onClick={() => onGoLedger?.()}>
            {tr("dash.firstEntry")}
          </Button>
        </div>
      )}
      {/* 置顶快捷记账条：记一笔就走，AI 自动分类 */}
      <QuickLedgerBar />

      {/* 指数行情条：大盘一眼可读 */}
      <IndicesStrip indices={dashboard.indices} />

      {/* 资产抬头：总资产 / 今日盈亏 / 持仓市值 / 可用现金，竖线分隔 */}
      <div className="grid grid-cols-2 gap-y-3 rounded-[var(--radius)] border border-border bg-card px-3 py-1 sm:grid-cols-4 sm:divide-x sm:divide-border/70">
        <StatCell label={tr("dash.totalAssets")} value={fmtMoney(t.total_market_value, false, compact)} sub={`${tr("dash.costBasis")} ${fmtMoney(t.total_cost, false, compact)}`} />
        <StatCell
          label={tr("dash.todayPnl")}
          value={fmtMoney(todayPnl, true, compact)}
          sub={`${tr("dash.holdingsValue")} ${fmtMoney(holdingsValue, false, compact)}`}
          tone={todayPnl >= 0 ? "up" : "down"}
        />
        <StatCell label={tr("dash.totalPnl")} value={fmtMoney(t.total_pnl, true, compact)} sub={`${fmtPct(t.total_pnl_pct, true)}${t.total_pnl_pct !== 0 ? ` · ${t.total_pnl >= 0 ? tr("dash.unrealizedGain") : tr("dash.unrealizedLoss")}` : ""}`} tone={t.total_pnl >= 0 ? "up" : "down"} />
        <StatCell label={tr("dash.cashAvailable")} value={fmtMoney(cash, false, compact)} sub={`${cf.month} ${tr("dash.net")} ${fmtMoney(cf.net, true, compact)}`} />
      </div>

      {/* 本月预算（设置后显示） */}
      <BudgetCard budget={budget} />

      {/* 财务目标 + 体检入口 */}
      <GoalsCard goals={dashboard.goals ?? []} net={dashboard.cashflow.net} />

      {/* 资产分布 + 持仓速览：一眼看懂钱在哪、今天怎么样 */}
      <div className="grid lg:grid-cols-2 gap-3">
        <Card className="p-[var(--card-pad)]">
          <div className="text-sm font-medium mb-2">{tr("dash.assetMix")}</div>
          <AssetPie data={dashboard} />
        </Card>
        <TopHoldings dashboard={dashboard} />
      </div>

      {/* 需要注意的事：待扣款 + 风险 + 预算/目标提醒，一眼看完 */}
      <div className="space-y-3">
        <DueSoonStrip dashboard={dashboard} />
        <AlertLine budget={budget} goals={dashboard.goals ?? []} />
        <RiskBanner flags={dashboard.flags} />
      </div>

      {/* 明细默认收起：图表 + 持仓，展开后才挂载（ECharts 运行时懒加载，不拖累首屏） */}
      <details ref={detailsRef} className="group rounded-[var(--radius)] border border-border bg-card">
        <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-medium">
          <span>
            {tr("dash.details")}
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {tr("dash.detailsSub")}
            </span>
          </span>
          <ChevronDown className="w-4 h-4 text-muted-foreground transition-transform group-open:rotate-180" />
        </summary>
        {detailsOpen && (
          <div className="space-y-3 border-t border-border p-3">
          <Card className="p-[var(--card-pad)]">
            <div className="text-sm font-medium mb-2">{tr("dash.spendingMix", { m: cf.month })}</div>
            <ExpenseBar data={dashboard} />
          </Card>

          <Card className="p-[var(--card-pad)]">
            <div className="text-sm font-medium mb-2">{tr("dash.trendTitle")}</div>
            {trend === null ? (
              <div className="h-56">
                <Skeleton className="h-full w-full" />
              </div>
            ) : trend.length > 0 ? (
              <TrendChart trend={trend} />
            ) : (
              <div className="h-40 flex items-center justify-center text-sm text-muted-foreground">
                {tr("dash.trendEmpty")}
              </div>
            )}
          </Card>

          <div className="grid lg:grid-cols-2 gap-3">
            <EmergencyCard data={dashboard} />
            <Card className="p-[var(--card-pad)]">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium">{tr("dash.debt")}</div>
                <Badge variant={dashboard.debts.dti_pct > 40 ? "warn" : "ok"}>
                  {tr("dash.dti", { n: dashboard.debts.dti_pct })}
                </Badge>
              </div>
              {dashboard.debts.items.length === 0 ? (
                <div className="mt-3 text-sm text-muted-foreground">{tr("dash.noDebt")}</div>
              ) : (
                <ul className="mt-3 space-y-2">
                  {dashboard.debts.items.map((d) => (
                    <li key={d.name} className="flex items-center justify-between text-sm">
                      <span>
                        {d.name}
                        <span className="text-xs text-muted-foreground ml-2">
                          {tr("dash.rate", { r: (d.rate * 100).toFixed(1) })}{d.due_day ? ` · ${tr("dash.dueOn", { d: d.due_day })} ${tr("dash.repay")}` : ""}
                        </span>
                      </span>
                      <span className="tabular-nums">{fmtMoney(d.monthly, false, compact)}{tr("dash.perMonth")}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <Card className="p-[var(--card-pad)]">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm font-medium">{tr("dash.positions")}</div>
              <span className="text-xs text-muted-foreground">{dashboard.source.quotes}</span>
            </div>
            <PositionsTable rows={dashboard.positions} compact={compact} />
          </Card>
          </div>
        )}
      </details>
    </div>
  );
}
