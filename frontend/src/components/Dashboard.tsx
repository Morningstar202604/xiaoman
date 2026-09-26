import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, NotebookPen, RefreshCw } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton, DashboardSkeleton } from "@/components/ui/skeleton";
import { useEChart, usePalette, axisLabelColor } from "@/lib/charts";
import { useTheme } from "@/lib/theme";
import { api } from "@/lib/api";
import { store } from "@/lib/store";
import { fmtMoney, fmtPct, fmtMonth } from "@/lib/format";
import { PositionsTable } from "@/components/PositionsTable";
import type { DashboardData, TrendMonth, BudgetUsage } from "@/lib/types";

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
  /* 摘掉的配饰：原来这里是一只和统计卡/待扣提醒同款的白色圆角卡。
     4 项风险自己会说话，不需要第三个同款盒子——改成一段带竖线锚的列表。 */
  if (!flags.length) {
    return (
      <div className="flex items-center gap-2 border-l-2 border-emerald-500/60 pl-3 py-1 text-sm">
        <CheckCircle2 className="w-4 h-4 text-down shrink-0" />
        <span className="text-down text-balance">未发现明显风险项，当前财务状况整体稳健。</span>
      </div>
    );
  }
  return (
    <div className="border-l-2 border-amber-500/70 pl-3 py-1">
      <div className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
        <AlertTriangle className="w-4 h-4 shrink-0" />
        发现 {flags.length} 项需关注
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
        近期待扣提醒（{monthLabel}）
      </div>
      <div className="space-y-1.5">
        {dueToday.length > 0 && (
          <div className="border-l-2 border-red-500/70 pl-2.5">
            <div className="text-xs font-medium text-red-600 dark:text-red-400">今天到期 · 共 {fmtMoney(totalToday, false)}</div>
            <div className="mt-0.5 flex gap-x-3 gap-y-0.5 flex-wrap text-xs text-muted-foreground">
              {dueToday.map((i) => (
                <span key={i.name} className="tabular-nums">
                  {i.name} {fmtMoney(i.amount, false)}（{i.due} 号{i.kind === "还款" ? "还款" : "扣款"}）
                </span>
              ))}
            </div>
          </div>
        )}
        {dueSoon.length > 0 && (
          <div className="border-l-2 border-amber-500/70 pl-2.5">
            <div className="text-xs font-medium text-amber-600 dark:text-amber-400">近 3 天内到期 · 共 {fmtMoney(totalSoon, false)}</div>
            <div className="mt-0.5 flex gap-x-3 gap-y-0.5 flex-wrap text-xs text-muted-foreground">
              {dueSoon.map((i) => (
                <span key={i.name} className="tabular-nums">
                  {i.name} {fmtMoney(i.amount, false)}（{Number(i.due) < day ? "下月" : ""}{i.due} 号{i.kind === "还款" ? "还款" : "扣款"}）
                </span>
              ))}
            </div>
          </div>
        )}
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
      tooltip: { trigger: "item", triggerOn: "click", renderMode: "richText", confine: true, formatter: "{b}\n占比 {d}%" },
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
        axisLabel: { fontSize: 10, color: axisLabelColor(resolved), formatter: (v: number) => (v >= 10000 ? `${(v / 10000).toFixed(1)}万` : `${v}`) },
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
        axisLabel: { fontSize: 10, color: axisLabelColor(resolved), formatter: (v: number) => (v >= 10000 ? `${(v / 10000).toFixed(1)}万` : `${v}`) },
        splitLine: { lineStyle: { type: "dashed", color: "hsl(var(--border))" } },
      },
      series: [
        {
          name: "收入",
          type: "bar",
          data: trend.map((t) => t.income),
          itemStyle: { color: palette[2], borderRadius: [4, 4, 0, 0] },
          barWidth: 12,
        },
        {
          name: "支出",
          type: "bar",
          data: trend.map((t) => t.expense),
          itemStyle: { color: palette[5], borderRadius: [4, 4, 0, 0] },
          barWidth: 12,
        },
        {
          name: "结余",
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
  const em = data.emergency;
  const pct = em.has_data && em.target_months ? Math.min(100, (em.months_covered / em.target_months) * 100) : 0;
  return (
    <Card className="p-[var(--card-pad)]">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">应急金</div>
        {em.has_data ? (
          <Badge variant={em.ok ? "ok" : "warn"}>{em.ok ? "达标" : "不足"}</Badge>
        ) : (
          <Badge variant="muted">暂无数据</Badge>
        )}
      </div>
      <div className="mt-3 flex items-baseline gap-1">
        <span className="text-2xl font-bold tabular-nums">{em.has_data ? em.months_covered : "—"}</span>
        <span className="text-sm text-muted-foreground">
          {em.has_data ? `个月（目标 ${em.target_months} 个月）` : "本月无必要支出，暂无法估算"}
        </span>
      </div>
      <div className="mt-2 h-2 rounded-full bg-muted overflow-hidden">
        <div
          className={`h-full rounded-full ${em.has_data && !em.ok ? "bg-amber-500" : "bg-down"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-2 text-xs text-muted-foreground">
        现金 {fmtMoney(em.cash)} / 必要月支出 {fmtMoney(em.essential_monthly)}
      </div>
    </Card>
  );
}

/** 本月预算：总预算进度 + 剩余日均 + 分类进度；未设置预算时不占位 */
function BudgetCard() {
  const [budget, setBudget] = useState<BudgetUsage | null>(null);
  const { bootstrap, refreshTick } = store.useApp();
  const compact = bootstrap?.settings.compact_numbers === "on";
  useEffect(() => {
    let alive = true;
    api<BudgetUsage>("/api/budgets")
      .then((r) => alive && setBudget(r))
      .catch(() => alive && setBudget(null));
    return () => {
      alive = false;
    };
  }, [refreshTick]);

  if (!budget || budget.usage.total_budget <= 0) return null;
  const u = budget.usage;
  const barCls = u.over ? "bg-red-500" : u.total_pct >= 80 ? "bg-amber-500" : "bg-down";
  return (
    <Card className="p-[var(--card-pad)]">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">{budget.month} 预算</div>
        <Badge variant={u.over ? "warn" : "ok"}>{u.over ? "已超支" : u.total_pct >= 80 ? "接近上限" : "进度正常"}</Badge>
      </div>
      <div className="mt-3 flex items-baseline gap-1">
        <span className="text-2xl font-bold tabular-nums">{fmtMoney(u.total_spent, false, compact)}</span>
        <span className="text-sm text-muted-foreground">/ {fmtMoney(u.total_budget, false, compact)}（{u.total_pct}%）</span>
      </div>
      <div className="mt-2 h-2 rounded-full bg-muted overflow-hidden">
        <div className={`h-full rounded-full ${barCls}`} style={{ width: `${Math.min(100, u.total_pct)}%` }} />
      </div>
      <div className="mt-2 text-xs text-muted-foreground">
        {u.over ? `超支 ${fmtMoney(-u.left, false, compact)}` : `剩余 ${fmtMoney(u.left, false, compact)}`}
        {" · 日均 "}
        {u.over ? `超 ${fmtMoney(-u.left_daily, false, compact)}` : `可用 ${fmtMoney(u.left_daily, false, compact)}`}
      </div>
      {u.categories.filter((c) => c.budget > 0).length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {u.categories.filter((c) => c.budget > 0).slice(0, 4).map((c) => (
            <li key={c.category} className="text-xs">
              <div className="flex justify-between text-muted-foreground">
                <span>{c.category}</span>
                <span className={c.over ? "text-red-500 font-medium" : ""}>
                  {fmtMoney(c.spent, false, compact)} / {fmtMoney(c.budget, false, compact)}
                  {c.over ? " 超支" : ""}
                </span>
              </div>
              <div className="mt-0.5 h-1.5 rounded-full bg-muted overflow-hidden">
                <div
                  className={`h-full rounded-full ${c.over ? "bg-red-500" : c.pct >= 80 ? "bg-amber-500" : "bg-down"}`}
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

export function Dashboard({ onGoLedger }: { onGoLedger?: () => void } = {}) {
  const { dashboard, loading, bootstrap, refreshTick } = store.useApp();
  const [trend, setTrend] = useState<TrendMonth[] | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const compact = (bootstrap?.settings.compact_numbers ?? "on") === "on";

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
        <p className="text-sm text-muted-foreground mb-3">暂时无法读取数据</p>
        <Button variant="outline" size="sm" onClick={() => store.refreshDashboard()}>
          <RefreshCw className="w-4 h-4" /> 重试
        </Button>
      </div>
    );
  }

  const t = dashboard.totals;
  const cf = dashboard.cashflow;
  const savingsGoal = Number(bootstrap?.settings.savings_goal ?? 20);

  // 空数据降级为引导：不渲染零值统计卡与风险横幅（零值 + 误报警是新用户劝退组合）
  if (dashboard.positions.length === 0 && dashboard.transactions.length === 0) {
    return (
      <div className="space-y-3">
        <Card className="p-6 text-center">
          <div className="text-base font-semibold">这里还没有你的数据</div>
          <p className="mt-1.5 text-sm text-muted-foreground text-balance">
            记一笔账或添加持仓，仪表盘就会显示总览、趋势和风险提示；现在也可以直接去问答里随便问点什么。
          </p>
          <div className="mt-4 flex justify-center">
            <Button size="sm" onClick={() => onGoLedger?.()}>
              <NotebookPen className="w-4 h-4" /> 去记账
            </Button>
          </div>
        </Card>
        <p className="px-2 text-xs text-muted-foreground">
          想先看效果？可到「设置 → 数据与状态」载入示例数据。
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* 示例数据横幅：首启种入的示例数据必须明说，避免被当成自己的真实数据 */}
      {dashboard.source.seeded && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius)] border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          <span>当前显示的是示例数据，不是你的真实账本。</span>
          <Button variant="outline" size="sm" className="h-6 px-2" onClick={() => onGoLedger?.()}>
            记我的第一笔
          </Button>
        </div>
      )}
      {/* 账本抬头：四个关键数字一行排开，竖线分隔（替代四张同款白卡） */}
      <div className="grid grid-cols-2 gap-y-3 rounded-[var(--radius)] border border-border bg-card px-3 py-1 sm:grid-cols-4 sm:divide-x sm:divide-border/70">
        <StatCell label="总资产" value={fmtMoney(t.total_market_value, false, compact)} sub={`投入成本 ${fmtMoney(t.total_cost, false, compact)}`} />
        <StatCell
          label="累计盈亏"
          value={fmtMoney(t.total_pnl, true, compact)}
          sub={`${fmtPct(t.total_pnl_pct, true)}${t.total_pnl_pct !== 0 ? ` · ${t.total_pnl >= 0 ? "浮盈" : "浮亏"}` : ""}`}
          tone={t.total_pnl >= 0 ? "up" : "down"}
        />
        <StatCell label={`${cf.month} 结余`} value={fmtMoney(cf.net, true, compact)} sub={`收入 ${fmtMoney(cf.income, false, compact)} · 支出 ${fmtMoney(cf.expense, false, compact)}`} />
        <StatCell label="储蓄率" value={`${cf.savings_rate}%`} sub={cf.savings_rate < savingsGoal ? `低于 ${savingsGoal}% 建议线` : "健康水平"} />
      </div>

      {/* 本月预算（设置后显示） */}
      <BudgetCard />

      {/* 需要注意的事：待扣款 + 风险，一眼看完 */}
      <div className="space-y-3">
        <DueSoonStrip dashboard={dashboard} />
        <RiskBanner flags={dashboard.flags} />
      </div>

      {/* 明细默认收起：图表 + 持仓，展开后才挂载（ECharts 运行时懒加载，不拖累首屏） */}
      <details ref={detailsRef} className="group rounded-[var(--radius)] border border-border bg-card">
        <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-medium">
          <span>
            明细分析
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              资产分布 · 支出结构 · 6 个月趋势 · 持仓 · 应急金
            </span>
          </span>
          <ChevronDown className="w-4 h-4 text-muted-foreground transition-transform group-open:rotate-180" />
        </summary>
        {detailsOpen && (
          <div className="space-y-3 border-t border-border p-3">
          <div className="grid lg:grid-cols-2 gap-3">
            <Card className="p-[var(--card-pad)]">
              <div className="text-sm font-medium mb-2">资产分布</div>
              <AssetPie data={dashboard} />
            </Card>
            <Card className="p-[var(--card-pad)]">
              <div className="text-sm font-medium mb-2">{cf.month} 支出结构</div>
              <ExpenseBar data={dashboard} />
            </Card>
          </div>

          <Card className="p-[var(--card-pad)]">
            <div className="text-sm font-medium mb-2">近 6 个月收支趋势</div>
            {trend === null ? (
              <div className="h-56">
                <Skeleton className="h-full w-full" />
              </div>
            ) : trend.length > 0 ? (
              <TrendChart trend={trend} />
            ) : (
              <div className="h-40 flex items-center justify-center text-sm text-muted-foreground">
                流水数据不足以绘制趋势，去「记账」记几笔吧。
              </div>
            )}
          </Card>

          <div className="grid lg:grid-cols-2 gap-3">
            <EmergencyCard data={dashboard} />
            <Card className="p-[var(--card-pad)]">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium">负债</div>
                <Badge variant={dashboard.debts.dti_pct > 40 ? "warn" : "ok"}>
                  月供占收入 {dashboard.debts.dti_pct}%
                </Badge>
              </div>
              {dashboard.debts.items.length === 0 ? (
                <div className="mt-3 text-sm text-muted-foreground">无负债记录</div>
              ) : (
                <ul className="mt-3 space-y-2">
                  {dashboard.debts.items.map((d) => (
                    <li key={d.name} className="flex items-center justify-between text-sm">
                      <span>
                        {d.name}
                        <span className="text-xs text-muted-foreground ml-2">
                          利率 {(d.rate * 100).toFixed(1)}%{d.due_day ? ` · ${d.due_day} 号还` : ""}
                        </span>
                      </span>
                      <span className="tabular-nums">{fmtMoney(d.monthly, false, compact)}/月</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <Card className="p-[var(--card-pad)]">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm font-medium">持仓明细</div>
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
