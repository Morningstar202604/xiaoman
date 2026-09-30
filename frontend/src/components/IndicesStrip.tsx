import { Activity } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { fmtMoney, fmtPct, pnlClass } from "@/lib/format";
import type { IndexQuote } from "@/lib/types";

/** 指数行情条：四大指数实时涨跌，横向滚动（失败时整条隐藏）。总览与行情页共用。 */
export function IndicesStrip({ indices }: { indices: IndexQuote[] }) {
  const { t } = useI18n();
  if (!indices.length) return null;
  return (
    <div className="rounded-[var(--radius)] border border-border bg-card px-3 py-2">
      <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Activity className="w-3.5 h-3.5" /> {t("dash.market")}
      </div>
      <div className="flex gap-6 overflow-x-auto scroll-thin pb-0.5">
        {indices.map((i) => (
          <div key={i.symbol} className="shrink-0 text-sm">
            <span className="text-muted-foreground">{i.name}</span>
            <span className="ml-2 tabular-nums font-medium">{fmtMoney(i.price, false, true)}</span>
            <span className={`ml-1.5 tabular-nums ${pnlClass(i.change_pct)}`}>{fmtPct(i.change_pct, true)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
