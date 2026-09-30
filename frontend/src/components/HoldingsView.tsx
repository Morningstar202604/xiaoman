import { useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { LineChart } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { store } from "@/lib/store";
import { fmtMoney, pnlClass } from "@/lib/format";
import { PositionsTable } from "@/components/PositionsTable";
import { cn } from "@/lib/utils";

/** 持仓页：按 股票/基金/理财 分组明细 + 风险概览（集中度 / 行业分布）。 */
export function HoldingsView({ onGoMarket }: { onGoMarket?: () => void } = {}) {
  const { t } = useI18n();
  const { dashboard, bootstrap } = store.useApp();
  const compact = (bootstrap?.settings.compact_numbers ?? "on") === "on";
  const positions = dashboard?.positions ?? [];

  const kinds = useMemo(() => ["all", ...Array.from(new Set(positions.map((p) => p.kind)))], [positions]);
  const [kind, setKind] = useState<string>("all");

  if (!dashboard) return null;

  // 空持仓引导：新用户还没有任何持仓时不给零值统计与空图表
  if (positions.length === 0) {
    return (
      <div className="space-y-3">
        <Card className="p-6 text-center">
          <div className="text-base font-semibold">{t("hold.emptyTitle")}</div>
          <p className="mt-1.5 text-sm text-muted-foreground text-balance">{t("hold.emptyDesc")}</p>
          <div className="mt-4 flex justify-center">
            <Button size="sm" onClick={() => onGoMarket?.()}>
              <LineChart className="w-4 h-4" /> {t("hold.emptyBtn")}
            </Button>
          </div>
        </Card>
        <p className="px-2 text-xs text-muted-foreground">{t("hold.emptyHint")}</p>
      </div>
    );
  }

  const filtered = kind === "all" ? positions : positions.filter((p) => p.kind === kind);
  const cash = positions.filter((p) => p.kind === "现金").reduce((s, p) => s + p.cost, 0);
  const totalMV = positions.reduce((s, p) => s + p.market_value, 0) - cash;
  const totalPnl = positions.reduce((s, p) => s + p.pnl, 0);
  const todayTotal = dashboard.today_pnl.total;
  const byAsset = [...dashboard.concentration.by_asset].sort((a, b) => b.pct - a.pct).slice(0, 3);
  const byIndustry = [...dashboard.concentration.by_industry].sort((a, b) => b.pct - a.pct).slice(0, 4);

  return (
    <div className="space-y-3">
      {/* 摘要行：市值 / 今日盈亏 / 累计盈亏 / 现金 */}
      <div className="grid grid-cols-2 gap-y-3 rounded-[var(--radius)] border border-border bg-card px-3 py-1 sm:grid-cols-4 sm:divide-x sm:divide-border/70">
        <div className="min-w-0 px-3 py-2 first:pl-0 sm:px-4">
          <div className="text-xs text-muted-foreground">{t("dash.holdingsValue")}</div>
          <div className="mt-1 text-xl font-bold tabular-nums num-in leading-tight">{fmtMoney(totalMV, false, compact)}</div>
        </div>
        <div className="min-w-0 px-3 py-2 first:pl-0 sm:px-4">
          <div className="text-xs text-muted-foreground">{t("dash.todayPnl")}</div>
          <div className={`mt-1 text-xl font-bold tabular-nums num-in leading-tight ${pnlClass(todayTotal)}`}>{fmtMoney(todayTotal, true, compact)}</div>
        </div>
        <div className="min-w-0 px-3 py-2 first:pl-0 sm:px-4">
          <div className="text-xs text-muted-foreground">{t("dash.totalPnl")}</div>
          <div className={`mt-1 text-xl font-bold tabular-nums num-in leading-tight ${pnlClass(totalPnl)}`}>{fmtMoney(totalPnl, true, compact)}</div>
        </div>
        <div className="min-w-0 px-3 py-2 first:pl-0 sm:px-4">
          <div className="text-xs text-muted-foreground">{t("dash.cashAvailable")}</div>
          <div className="mt-1 text-xl font-bold tabular-nums num-in leading-tight">{fmtMoney(cash, false, compact)}</div>
        </div>
      </div>

      {/* 风险概览 */}
      <div className="grid sm:grid-cols-2 gap-3">
        <Card className="p-[var(--card-pad)]">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium">{t("holdings.concentration")}</span>
            <Badge variant={dashboard.concentration.threshold_pct > 40 ? "warn" : "muted"}>
              {t("holdings.threshold", { n: dashboard.concentration.threshold_pct })}
            </Badge>
          </div>
          {byAsset.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("holdings.empty")}</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {byAsset.map((a) => (
                <li key={a.name} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate">{a.name}</span>
                  <span className="flex items-center gap-2 shrink-0">
                    <span className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                      <span className="block h-full rounded-full bg-primary" style={{ width: `${Math.min(100, a.pct)}%` }} />
                    </span>
                    <span className="w-10 text-right tabular-nums text-muted-foreground">{a.pct}%</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card className="p-[var(--card-pad)]">
          <div className="mb-2 text-sm font-medium">{t("holdings.industry")}</div>
          {byIndustry.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("holdings.empty")}</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {byIndustry.map((x) => (
                <li key={x.industry} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate">{x.industry}</span>
                  <span className="w-10 text-right tabular-nums text-muted-foreground">{x.pct}%</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/* 明细：按 kind 分组 */}
      <Card className="p-[var(--card-pad)]">
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {kinds.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium border transition-colors",
                kind === k ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {k === "all" ? t("holdings.all") : k}
            </button>
          ))}
          <span className="ml-auto text-xs text-muted-foreground">
            {filtered.length} {t("holdings.items")}
          </span>
        </div>
        {filtered.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t("holdings.empty")}</p>
        ) : (
          <PositionsTable rows={filtered} compact={compact} />
        )}
      </Card>
    </div>
  );
}
