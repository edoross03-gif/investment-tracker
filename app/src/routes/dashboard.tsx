import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { RefreshCw, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/dashboard")({
  head: () => ({ meta: [{ title: "Dashboard — Portfolio" }] }),
  component: DashboardPage,
});

type Position = {
  id: string;
  ticker: string;
  name: string | null;
  platform: string | null;
  asset_type: string | null;
  quantity: number;
  avg_buy_price: number;
  native_currency: string | null;
  manual_price: boolean | null;
  created_at: string;
};

type RealizedKind = "sale" | "dividend" | "coupon" | "transfer";

type RealizedRow = {
  id: string;
  ticker: string | null;
  platform: string | null;
  kind: RealizedKind | string | null;
  realized_eur: number;
  updated_at: string;
};

// An upload is a full snapshot of one platform and replaces the previous one. Older snapshots can
// survive in the database (uploads made under different sign-ins could not delete each other's
// rows), and counting them would double every total. Keep only the newest upload of each platform.
function latestUpload<T extends { platform: string | null }>(
  rows: T[],
  stamp: (r: T) => string,
): { kept: T[]; hidden: number } {
  const newest: Record<string, number> = {};
  for (const r of rows) {
    const k = r.platform ?? "";
    const t = new Date(stamp(r)).getTime();
    if (!(k in newest) || t > newest[k]) newest[k] = t;
  }
  const kept = rows.filter(
    (r) => newest[r.platform ?? ""] - new Date(stamp(r)).getTime() < 60_000,
  );
  return { kept, hidden: rows.length - kept.length };
}

type PriceInfo = {
  price_native?: number;
  native_currency?: string;
  price_eur?: number;
  source?: string;
  error?: string;
};

type PricesResponse = {
  eurusd: number;
  eurgbp: number;
  prices: Record<string, PriceInfo>;
};

const fmtEUR = (n: number) =>
  new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR", maximumFractionDigits: 2 }).format(n);
const fmtNum = (n: number, d = 4) =>
  new Intl.NumberFormat("en-IE", { maximumFractionDigits: d }).format(n);
const fmtPct = (n: number) =>
  `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;

function DashboardPage() {
  const [positions, setPositions] = useState<Position[]>([]);
  const [realized, setRealized] = useState<RealizedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [pricesData, setPricesData] = useState<PricesResponse | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hiddenOld, setHiddenOld] = useState(0);

  const fetchPrices = useCallback(async (pos: Position[]) => {
    if (pos.length === 0) {
      setPricesData({ eurusd: 1, eurgbp: 1, prices: {} });
      setLastRefresh(new Date());
      return;
    }
    setRefreshing(true);
    try {
      const { data, error } = await supabase.functions.invoke("get-prices", {
        body: {
          positions: pos.map((p) => ({
            ticker: p.ticker,
            asset_type: p.asset_type,
            native_currency: p.native_currency,
            manual_price: !!p.manual_price,
          })),
        },
      });
      console.log("[get-prices] data:", data, "error:", error);
      if (error) throw error;
      setPricesData(data as PricesResponse);
      setLastRefresh(new Date());
    } catch (e) {
      toast.error(`Price fetch failed: ${(e as Error).message}`);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const [posRes, rzRes] = await Promise.all([
          supabase
            .from("positions")
            .select("id, ticker, name, platform, asset_type, quantity, avg_buy_price, native_currency, manual_price, created_at")
            .order("platform", { ascending: true })
            .order("ticker", { ascending: true }),
          supabase
            .from("realized_pnl")
            .select("id, ticker, platform, kind, realized_eur, updated_at")
            .order("platform", { ascending: true })
            .order("ticker", { ascending: true }),
        ]);
        if (posRes.error) throw posRes.error;
        if (rzRes.error) throw rzRes.error;
        const posLatest = latestUpload((posRes.data ?? []) as Position[], (r) => r.created_at);
        const rzLatest = latestUpload((rzRes.data ?? []) as RealizedRow[], (r) => r.updated_at);
        const pos = posLatest.kept;
        setPositions(pos);
        setRealized(rzLatest.kept);
        setHiddenOld(posLatest.hidden + rzLatest.hidden);
        await fetchPrices(pos);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, [fetchPrices]);

  const rows = useMemo(() => {
    return positions.map((p) => {
      const info = pricesData?.prices?.[p.ticker];
      const hasPrice = !p.manual_price && info && typeof info.price_eur === "number" && !info.error;
      const price_eur = hasPrice ? (info!.price_eur as number) : null;
      const cost = p.avg_buy_price * p.quantity;
      const market_value = price_eur != null ? price_eur * p.quantity : null;
      const pnl = market_value != null ? market_value - cost : null;
      const pnl_pct = pnl != null && cost > 0 ? (pnl / cost) * 100 : null;
      return { p, info, price_eur, cost, market_value, pnl, pnl_pct, hasPrice };
    });
  }, [positions, pricesData]);

  const totals = useMemo(() => {
    let value = 0, cost = 0;
    for (const r of rows) {
      if (r.market_value == null) continue;
      value += r.market_value;
      cost += r.cost;
    }
    const pnl = value - cost;
    const pnl_pct = cost > 0 ? (pnl / cost) * 100 : 0;
    return { value, cost, pnl, pnl_pct };
  }, [rows]);

  const realizedTotal = useMemo(
    () => realized.reduce((s, r) => s + Number(r.realized_eur || 0), 0),
    [realized]
  );
  const subTotals = useMemo(() => {
    const t = { sale: 0, transfer: 0, dividend: 0, coupon: 0 };
    for (const r of realized) {
      const k = (r.kind || "sale") as keyof typeof t;
      if (k in t) t[k] += Number(r.realized_eur || 0);
    }
    return t;
  }, [realized]);
  const totalReturn = totals.pnl + realizedTotal;

  const pnlColor = (n: number | null) =>
    n == null ? "" : n >= 0 ? "text-emerald-400" : "text-rose-400";

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Portfolio</h1>
          <p className="text-sm text-muted-foreground">
            {loading ? "Loading…" : `${positions.length} positions`}
            {lastRefresh && (
              <>
                {" · "}
                Updated {lastRefresh.toLocaleTimeString()}
                {pricesData && (
                  <> · EUR/USD {pricesData.eurusd.toFixed(4)}</>
                )}
              </>
            )}
            {hiddenOld > 0 && (
              <> · latest upload per platform ({hiddenOld} rows from older uploads hidden)</>
            )}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => fetchPrices(positions)}
          disabled={refreshing || loading || positions.length === 0}
        >
          <RefreshCw className={cn("mr-2 h-4 w-4", refreshing && "animate-spin")} />
          {refreshing ? "Refreshing…" : "Refresh prices"}
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <KpiCard label="Total value" value={fmtEUR(totals.value)} />
        <KpiCard label="Total cost" value={fmtEUR(totals.cost)} />
        <KpiCard
          label="Unrealized P&L"
          value={fmtEUR(totals.pnl)}
          valueClass={pnlColor(totals.pnl)}
        />
        <KpiCard
          label="Unrealized %"
          value={fmtPct(totals.pnl_pct)}
          valueClass={pnlColor(totals.pnl)}
        />
        <KpiCard
          label="Total Return"
          value={fmtEUR(totalReturn)}
          valueClass={pnlColor(totalReturn)}
        />
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Ticker</TableHead>
              <TableHead>Platform</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead className="text-right">Avg cost (EUR)</TableHead>
              <TableHead className="text-right">Live price (EUR)</TableHead>
              <TableHead className="text-right">Market value (EUR)</TableHead>
              <TableHead className="text-right">P&L (EUR)</TableHead>
              <TableHead className="text-right">P&L %</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(({ p, info, price_eur, market_value, pnl, pnl_pct, hasPrice }) => {
              const flagged = !hasPrice;
              return (
                <TableRow key={p.id} className={flagged ? "opacity-70" : ""}>
                  <TableCell className="font-mono text-sm">
                    <div className="flex items-center gap-1.5">
                      {p.ticker}
                      {flagged && (
                        <AlertCircle className="h-3.5 w-3.5 text-amber-400" />
                      )}
                    </div>
                    {p.manual_price && (
                      <div className="text-[10px] uppercase tracking-wide text-amber-400/80">manual</div>
                    )}
                    {!p.manual_price && info?.error && (
                      <div className="text-[10px] text-amber-400/80">{info.error}</div>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{p.platform ?? "—"}</TableCell>
                  <TableCell className="text-right font-mono">{fmtNum(p.quantity, 8)}</TableCell>
                  <TableCell className="text-right font-mono">{fmtNum(p.avg_buy_price, 4)}</TableCell>
                  <TableCell className="text-right font-mono">
                    {price_eur != null ? fmtNum(price_eur, 4) : <span className="text-muted-foreground">n/a</span>}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {market_value != null ? fmtEUR(market_value) : <span className="text-muted-foreground">n/a</span>}
                  </TableCell>
                  <TableCell className={cn("text-right font-mono", pnlColor(pnl))}>
                    {pnl != null ? fmtEUR(pnl) : <span className="text-muted-foreground">n/a</span>}
                  </TableCell>
                  <TableCell className={cn("text-right font-mono", pnlColor(pnl))}>
                    {pnl_pct != null ? fmtPct(pnl_pct) : <span className="text-muted-foreground">n/a</span>}
                  </TableCell>
                </TableRow>
              );
            })}
            {!loading && positions.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-sm text-muted-foreground">
                  No positions yet. Import a file from the Upload page.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <div className="space-y-3">
        <div className="flex items-end justify-between">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Realized &amp; Income</h2>
            <p className="text-xs text-muted-foreground">
              {realized.length} row{realized.length === 1 ? "" : "s"}
            </p>
          </div>
          <div className={cn("font-mono text-2xl font-semibold", pnlColor(realizedTotal))}>
            {fmtEUR(realizedTotal)}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <KpiCard label="Sales P&L" value={fmtEUR(subTotals.sale)} valueClass={pnlColor(subTotals.sale)} />
          <KpiCard label="Transfers" value={fmtEUR(subTotals.transfer)} valueClass={pnlColor(subTotals.transfer)} />
          <KpiCard label="Dividends" value={fmtEUR(subTotals.dividend)} valueClass={pnlColor(subTotals.dividend)} />
          <KpiCard label="Coupons" value={fmtEUR(subTotals.coupon)} valueClass={pnlColor(subTotals.coupon)} />
        </div>

        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Ticker</TableHead>
                <TableHead>Platform</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead className="text-right">Amount (EUR)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {realized.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-sm">{r.ticker ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground">
                    <span className="inline-flex items-center gap-2">
                      {r.platform ?? "—"}
                      {r.platform === "crypto.com" && (
                        <span className="rounded border border-amber-400/30 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-400/80">
                          ≈ approx
                        </span>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">{r.kind ?? "sale"}</TableCell>
                  <TableCell className={cn(
                    "text-right font-mono",
                    Number(r.realized_eur) >= 0 ? "text-emerald-400" : "text-rose-400"
                  )}>
                    {fmtEUR(Number(r.realized_eur))}
                  </TableCell>
                </TableRow>
              ))}
              {!loading && realized.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="py-8 text-center text-sm text-muted-foreground">
                    No realized P&L or income yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}

function KpiCard({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <Card className="p-5">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn("mt-2 text-2xl font-semibold tracking-tight font-mono", valueClass)}>
        {value}
      </div>
    </Card>
  );
}
