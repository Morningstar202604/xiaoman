import { useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtMoney } from "@/lib/format";
import { api } from "@/lib/api";
import { useEChart, axisLabelColor } from "@/lib/charts";
import { useTheme } from "@/lib/theme";
import { useI18n } from "@/lib/i18n";

export interface KlinePoint {
  date: string;
  close: number;
  pct_change?: number | null;
}

/** K 线弹层：近 60 日收盘价走势（A股/ETF；其他标的会提示不可用）。
 *  持仓表与行情页自选共用。 */
export function KlineDialog({
  symbol,
  name,
  open,
  onOpenChange,
}: {
  symbol: string;
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t: tr } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const { resolved } = useTheme();
  const [state, setState] = useState<{ loading: boolean; error?: string; points: KlinePoint[]; source?: string }>({
    loading: false,
    points: [],
  });

  useEffect(() => {
    if (!open || !symbol) return;
    let alive = true;
    setState({ loading: true, points: [] });
    api<{ points: KlinePoint[]; source: string; error?: string }>(`/api/kline?symbol=${encodeURIComponent(symbol)}&period=daily&limit=120`)
      .then((r) => {
        if (!alive) return;
        setState({ loading: false, points: r.points ?? [], source: r.source });
      })
      .catch((e) => {
        if (!alive) return;
        setState({ loading: false, points: [], error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      alive = false;
    };
  }, [open, symbol]);

  const option = useMemo(() => {
    const pts = state.points;
    const first = pts[0]?.close;
    const last = pts[pts.length - 1]?.close;
    const up = first != null && last != null && last >= first;
    const lineColor = up ? "#16a34a" : "#dc2626";
    return {
      tooltip: { trigger: "axis", triggerOn: "click", renderMode: "richText", confine: true },
      grid: { left: 8, right: 8, top: 20, bottom: 4, containLabel: true },
      xAxis: { type: "category", data: pts.map((p) => p.date), axisLabel: { fontSize: 10, color: axisLabelColor(resolved) } },
      yAxis: {
        type: "value",
        scale: true,
        axisLabel: { fontSize: 10, color: axisLabelColor(resolved) },
        splitLine: { lineStyle: { type: "dashed", color: "hsl(var(--border))" } },
      },
      series: [
        {
          type: "line",
          data: pts.map((p) => p.close),
          symbol: "none",
          lineStyle: { width: 2, color: lineColor },
          itemStyle: { color: lineColor },
          areaStyle: { opacity: 0.08, color: lineColor },
          markLine:
            first != null
              ? {
                  silent: true,
                  symbol: "none",
                  label: { show: false },
                  lineStyle: { type: "dashed", color: "hsl(var(--muted-foreground) / 0.4)" },
                  data: [{ yAxis: first }],
                }
              : undefined,
        },
      ],
    };
  }, [state.points, resolved]);
  useEChart(ref, state.points.length ? option : null, [state.points, resolved]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/45 backdrop-blur-sm data-[state=open]:animate-fade-in" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(94vw,34rem)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-card p-4 shadow-lift data-[state=open]:animate-fade-in">
          <div className="flex items-center justify-between">
            <Dialog.Title className="text-sm font-semibold">
              {name}
              <span className="text-xs text-muted-foreground ml-2 tabular-nums">{symbol}</span>
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                className="rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-accent"
                aria-label={tr("pos.close")}
              >
                ✕
              </button>
            </Dialog.Close>
          </div>
          <div className="mt-3">
            {state.loading ? (
              <div className="flex h-52 items-center justify-center text-xs text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin mr-2" /> {tr("pos.loading")}
              </div>
            ) : state.error || !state.points.length ? (
              <div className="flex h-52 items-center justify-center text-xs text-muted-foreground px-4 text-center">
                {state.error || tr("pos.noKline")}
              </div>
            ) : (
              <>
                <div ref={ref} className="h-56 w-full" />
                <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>
                    {tr("pos.klineInfo", { n: state.points.length })} · {state.source === "snapshot" ? tr("pos.snapshot") : tr("pos.realtime")}
                  </span>
                  {state.points.length >= 2 && (
                    <span className={cn("tabular-nums", state.points[state.points.length - 1].close >= state.points[0].close ? "text-up" : "text-down")}>
                      {fmtMoney(state.points[state.points.length - 1].close)}
                    </span>
                  )}
                </div>
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
