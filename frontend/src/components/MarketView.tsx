import { useCallback, useEffect, useState } from "react";
import { LineChart, Plus, RefreshCw, Search, X } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { IndicesStrip } from "@/components/IndicesStrip";
import { KlineDialog } from "@/components/KlineDialog";
import { useI18n } from "@/lib/i18n";
import { store } from "@/lib/store";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast";
import { fmtMoney, fmtPct, pnlClass } from "@/lib/format";
import { cn } from "@/lib/utils";

interface WatchItem {
  symbol: string;
  name: string;
  kind: string;
  price?: number;
  change?: number | null;
  change_pct?: number | null;
  quote_source?: string;
}

interface SearchHit {
  symbol: string;
  name: string;
  kind: string;
}

/** 行情页：大盘指数 + 自选（自己盯的标的，可搜索添加/删除，点行看 K 线）+ 持仓行情。 */
export function MarketView() {
  const { t } = useI18n();
  const { toast } = useToast();
  const { dashboard } = store.useApp();
  const [tab, setTab] = useState<"watch" | "holdings">("watch");
  const [watch, setWatch] = useState<WatchItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [kline, setKline] = useState<{ symbol: string; name: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<{ items: WatchItem[] }>("/api/watchlist");
      setWatch(r.items ?? []);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  // 搜索防抖：停顿 300ms 才请求
  useEffect(() => {
    const kw = q.trim();
    if (!kw || tab !== "watch") {
      setHits([]);
      return;
    }
    setSearching(true);
    const timer = window.setTimeout(() => {
      api<{ items: SearchHit[] }>(`/api/search?q=${encodeURIComponent(kw)}`)
        .then((r) => setHits(r.items ?? []))
        .catch(() => setHits([]))
        .finally(() => setSearching(false));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [q, tab]);

  const add = async (hit: SearchHit) => {
    try {
      await api("/api/watchlist", { method: "POST", body: JSON.stringify(hit) });
      toast(t("market.added", { name: hit.name }), "ok");
      setQ("");
      setHits([]);
      void load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };

  const remove = async (symbol: string) => {
    try {
      await api(`/api/watchlist/${encodeURIComponent(symbol)}`, { method: "DELETE" });
      setWatch((w) => w.filter((i) => i.symbol !== symbol));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };

  const holdings = (dashboard?.positions ?? []).filter((p) => p.kind !== "现金").sort((a, b) => b.market_value - a.market_value);

  return (
    <div className="space-y-3">
      <IndicesStrip indices={dashboard?.indices ?? []} />

      <Card className="p-[var(--card-pad)]">
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setTab("watch")}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs font-medium border transition-colors",
              tab === "watch" ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            {t("market.watchlist")}
          </button>
          <button
            type="button"
            onClick={() => setTab("holdings")}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs font-medium border transition-colors",
              tab === "holdings" ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            {t("market.holdingsTab")}
          </button>
          {tab === "watch" && (
            <span className="ml-auto flex items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground">{watch.length} {t("holdings.items")}</span>
              <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={t("market.refresh")} onClick={() => void load()}>
                <RefreshCw className={cn("w-3.5 h-3.5", loading && "animate-spin")} />
              </Button>
            </span>
          )}
        </div>

        {tab === "watch" ? (
          <>
            {/* 搜索添加 */}
            <div className="relative mb-3">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t("market.searchPh")}
                aria-label={t("market.searchPh")}
                className="w-full rounded-lg border border-input bg-background pl-8 pr-8 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                maxLength={20}
              />
              {q && (
                <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" onClick={() => { setQ(""); setHits([]); }} aria-label={t("market.clear")}>
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
            {q.trim() && (
              <div className="mb-3 space-y-0.5">
                {searching ? (
                  <p className="px-2 py-1.5 text-xs text-muted-foreground">{t("market.searching")}</p>
                ) : hits.length === 0 ? (
                  <p className="px-2 py-1.5 text-xs text-muted-foreground">{t("market.noResult")}</p>
                ) : (
                  hits.map((h) => (
                    <div key={h.symbol} className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-accent/50">
                      <span className="min-w-0">
                        <span className="text-sm font-medium truncate">{h.name}</span>
                        <span className="ml-1.5 text-xs text-muted-foreground">{h.kind} · {h.symbol}</span>
                      </span>
                      <Button size="sm" variant="outline" onClick={() => void add(h)}>
                        <Plus className="w-3.5 h-3.5" /> {t("market.add")}
                      </Button>
                    </div>
                  ))
                )}
              </div>
            )}

            {/* 自选列表 */}
            {watch.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">{t("market.emptyWatch")}</p>
            ) : (
              <ul className="divide-y divide-border/60">
                {watch.map((w) => (
                  <li key={w.symbol} className="flex items-center justify-between gap-2 py-2 text-sm">
                    <button
                      type="button"
                      className="min-w-0 text-left group"
                      onClick={() => setKline({ symbol: w.symbol, name: w.name })}
                      aria-label={t("pos.viewK", { name: w.name })}
                    >
                      <span className="truncate font-medium group-hover:text-primary">{w.name}</span>
                      <span className="ml-1.5 text-xs text-muted-foreground">{w.kind} · {w.symbol}</span>
                      <LineChart className="ml-1 inline w-3 h-3 text-muted-foreground/50 group-hover:text-primary" />
                    </button>
                    <span className="flex shrink-0 items-center gap-3 tabular-nums">
                      <span className="w-16 text-right">{w.price != null ? fmtMoney(w.price, false, true) : "—"}</span>
                      <span className={cn("w-16 text-right", pnlClass(w.change_pct ?? 0))}>{w.change_pct != null ? fmtPct(w.change_pct, true) : "—"}</span>
                      <button
                        type="button"
                        className="p-0.5 text-muted-foreground hover:text-red-600"
                        aria-label={t("market.remove", { name: w.name })}
                        onClick={() => void remove(w.symbol)}
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {watch.length > 0 && (
              <p className="mt-2 text-[11px] text-muted-foreground">
                {watch.some((w) => (w as { quote_source?: string }).quote_source === "snapshot")
                  ? t("market.srcSnapshot")
                  : t("market.quoteSrc")} · {t("notAdvice")}
              </p>
            )}
          </>
        ) : holdings.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t("holdings.empty")}</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {holdings.map((p) => {
              const day = dashboard?.today_pnl.items[p.symbol];
              return (
                <li key={p.symbol} className="flex items-center justify-between gap-2 py-2 text-sm">
                  <button
                    type="button"
                    className="min-w-0 text-left group"
                    onClick={() => setKline({ symbol: p.symbol, name: p.name })}
                    aria-label={t("pos.viewK", { name: p.name })}
                  >
                    <span className="truncate font-medium group-hover:text-primary">{p.name}</span>
                    <span className="ml-1.5 text-xs text-muted-foreground">{p.kind} · {p.symbol}</span>
                  </button>
                  <span className="flex shrink-0 items-center gap-3 tabular-nums">
                    <span className="w-16 text-right">{fmtMoney(p.last, false, true)}</span>
                    <span className={cn("w-16 text-right", pnlClass(day))}>{day != null ? fmtPct((day / Math.max(1, p.market_value)) * 100, true) : "—"}</span>
                    <span className={cn("w-20 text-right", pnlClass(p.pnl))}>{fmtMoney(p.pnl, true, true)}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <KlineDialog
        symbol={kline?.symbol ?? ""}
        name={kline?.name ?? ""}
        open={kline !== null}
        onOpenChange={(o) => !o && setKline(null)}
      />
    </div>
  );
}
