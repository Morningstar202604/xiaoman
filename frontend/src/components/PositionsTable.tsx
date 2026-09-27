import { useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowDown, ArrowUp, ArrowUpDown, LineChart, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtMoney, fmtPct, pnlClass } from "@/lib/format";
import { api } from "@/lib/api";
import { useEChart, axisLabelColor } from "@/lib/charts";
import { useTheme } from "@/lib/theme";
import type { Position } from "@/lib/types";

type SortKey = "weight" | "market_value" | "pnl" | "pnl_pct";

/** 持仓数据表：可排序、数字右对齐等宽、盈亏红涨绿跌；点行可查看 K 线走势。
 *  市值/盈亏由后端算好传入（与问答、图表同源，避免口径不一致）。 */
export function PositionsTable({
  rows,
  total,
  className,
  compact = false,
}: {
  rows: Position[];
  total?: number;
  className?: string;
  compact?: boolean;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("market_value");
  const [desc, setDesc] = useState(true);
  const [klineSymbol, setKlineSymbol] = useState<string | null>(null);

  const computed = useMemo(() => {
    const t = total ?? rows.reduce((s, r) => s + r.market_value, 0);
    return rows
      .map((r) => ({ ...r, weight: t ? (r.market_value / t) * 100 : 0 }))
      .sort((a, b) => (desc ? b[sortKey] - a[sortKey] : a[sortKey] - b[sortKey]));
  }, [rows, total, sortKey, desc]);

  const toggle = (k: SortKey) => {
    if (k === sortKey) setDesc((v) => !v);
    else {
      setSortKey(k);
      setDesc(true);
    }
  };

  const SortHead = ({ k, label }: { k: SortKey; label: string }) => (
    <th
      className="cursor-pointer select-none whitespace-nowrap px-2 py-1.5 font-medium text-muted-foreground transition-colors hover:text-foreground text-right"
      onClick={() => toggle(k)}
    >
      <span className="inline-flex items-center gap-0.5">
        {label}
        {sortKey === k ? (
          desc ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />
        ) : (
          <ArrowUpDown className="h-2.5 w-2.5 opacity-40" />
        )}
      </span>
    </th>
  );

  const clicked = rows.find((r) => r.symbol === klineSymbol);

  return (
    <>
      <div className={cn("scroll-thin overflow-x-auto rounded-lg border border-border bg-card", className)}>
        <table className="w-full border-collapse text-xs" style={{ fontVariantNumeric: "tabular-nums" }}>
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">标的</th>
              <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">类型</th>
              <SortHead k="weight" label="占比" />
              <th className="px-2 py-1.5 text-right font-medium text-muted-foreground">现价</th>
              <SortHead k="market_value" label="市值" />
              <SortHead k="pnl" label="盈亏" />
              <SortHead k="pnl_pct" label="盈亏%" />
            </tr>
          </thead>
          <tbody>
            {computed.map((r) => (
              <tr key={r.symbol} className="border-b border-border/60 last:border-0 hover:bg-accent/40">
                <td className="px-2 py-1.5">
                  <button
                    type="button"
                    className="text-left group inline-flex items-center gap-1"
                    onClick={() => setKlineSymbol(r.symbol)}
                    aria-label={`查看 ${r.name} K线`}
                  >
                    <span className="font-medium text-foreground group-hover:text-primary">{r.name}</span>
                    <span className="text-[10px] text-muted-foreground">{r.symbol}</span>
                    <LineChart className="w-3 h-3 text-muted-foreground/50 group-hover:text-primary" />
                  </button>
                </td>
                <td className="px-2 py-1.5 text-muted-foreground">{r.kind}</td>
                <td className="px-2 py-1.5 text-right">
                  <span
                    className={cn(
                      "rounded px-1 py-0.5",
                      r.weight > 40 ? "bg-amber-100 text-amber-700" : "text-foreground",
                    )}
                  >
                    {r.weight.toFixed(1)}%
                  </span>
                </td>
                <td className="px-2 py-1.5 text-right text-muted-foreground">{fmtMoney(r.last, false, compact)}</td>
                <td className="px-2 py-1.5 text-right font-medium">{fmtMoney(r.market_value, false, compact)}</td>
                <td className={cn("px-2 py-1.5 text-right", pnlClass(r.pnl))}>{fmtMoney(r.pnl, true, compact)}</td>
                <td className={cn("px-2 py-1.5 text-right", pnlClass(r.pnl))}>{fmtPct(r.pnl_pct, true)}</td>
              </tr>
            ))}
            {computed.length === 0 && (
              <tr>
                <td colSpan={7} className="px-2 py-3 text-center text-muted-foreground">
                  暂无持仓数据
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* K 线详情：点标的行打开 */}
      <KlineDialog
        position={clicked}
        open={klineSymbol !== null}
        onOpenChange={(o) => !o && setKlineSymbol(null)}
      />
    </>
  );
}

interface KlinePoint {
  date: string;
  close: number;
  pct_change?: number | null;
}

/** K 线弹层：近 60 日收盘价走势（A股/ETF；其他标的会提示不可用）。 */
function KlineDialog({
  position,
  open,
  onOpenChange,
}: {
  position?: Position;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { resolved } = useTheme();
  const [state, setState] = useState<{ loading: boolean; error?: string; points: KlinePoint[]; source?: string }>({
    loading: false,
    points: [],
  });

  useEffect(() => {
    if (!open || !position) return;
    let alive = true;
    setState({ loading: true, points: [] });
    api<{ points: KlinePoint[]; source: string; error?: string }>(`/api/kline?symbol=${encodeURIComponent(position.symbol)}&period=daily&limit=120`)
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
  }, [open, position]);

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
              {position?.name ?? ""}
              <span className="text-xs text-muted-foreground ml-2 tabular-nums">{position?.symbol}</span>
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                className="rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-accent"
                aria-label="关闭"
              >
                ✕
              </button>
            </Dialog.Close>
          </div>
          <div className="mt-3">
            {state.loading ? (
              <div className="flex h-52 items-center justify-center text-xs text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin mr-2" /> 加载行情中…
              </div>
            ) : state.error || !state.points.length ? (
              <div className="flex h-52 items-center justify-center text-xs text-muted-foreground px-4 text-center">
                {state.error || "暂无可用的 A 股/ETF 行情（基金/现金类持仓暂无 K 线）"}
              </div>
            ) : (
              <>
                <div ref={ref} className="h-56 w-full" />
                <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>
                    近 {state.points.length} 个交易日收盘价 · {state.source === "snapshot" ? "快照行情" : "实时行情"}
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
