// Real parsers for Revolut (.xlsx) and Crypto.com (.csv).
// Each returns { positions, realized, notes }.

export type ParsedPosition = {
  ticker: string;
  name: string | null;
  platform: "revolut" | "crypto.com";
  asset_type: "crypto" | "stock" | "etf" | "bond";
  quantity: number;
  avg_buy_price: number;
  buy_currency: string;
  native_currency: string | null;
  manual_price: boolean;
};

export type RealizedKind = "sale" | "dividend" | "coupon" | "transfer";

export type ParsedRealized = {
  ticker: string;
  platform: "revolut" | "crypto.com";
  kind: RealizedKind;
  realized_eur: number;
};

export type ParseResult = {
  positions: ParsedPosition[];
  realized: ParsedRealized[];
  /** Things the user should know about this parse (gaps in the history, approximations). */
  notes: string[];
};

export type Source = "revolut" | "crypto.com";

/** USD → EUR rate for a date (ISO string, the first 10 characters are used). */
export type FxLookup = (isoDate: string) => number;

function parseAmt(s: unknown): [string | null, number | null] {
  if (s == null) return [null, null];
  const m = String(s).replace(/,/g, "").match(/([A-Z]{3})\s*(-?[\d.]+)/);
  return m ? [m[1], parseFloat(m[2])] : [null, null];
}

function isISIN(t: string | null | undefined): boolean {
  return /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(t || "");
}

export function parseRevolut(rows: Record<string, unknown>[]): ParseResult {
  // Revolut lists European shares under their local symbol (DHL, NESR) and trades them in EUR.
  // The price feed needs the exchange suffix: without it the bare symbol can be a different
  // company altogether (NESR alone is a US-listed oil-services firm, not Nestlé).
  const TICKER_MAP: Record<string, string> = {};
  const eurTickers = new Set<string>();
  for (const r of rows) {
    if (r["Ticker"] && String(r["Currency"]) === "EUR") eurTickers.add(String(r["Ticker"]));
  }
  const mapTk = (t: string) =>
    TICKER_MAP[t] || (eurTickers.has(t) && !isISIN(t) && !t.includes(".") ? `${t}.DE` : t);
  const nativeBy: Record<string, string> = {};

  const trades = rows
    .filter(
      (r) =>
        ["BUY - MARKET", "SELL - MARKET", "STOCK SPLIT", "BOND REDEMPTION"].includes(String(r["Type"])) &&
        r["Ticker"]
    )
    .sort(
      (a, b) =>
        new Date(String(a["Date"])).getTime() - new Date(String(b["Date"])).getTime()
    );

  const byTicker: Record<string, { qty: number; cost: number }> = {};
  const realizedBy: Record<string, number> = {};
  for (const r of trades) {
    const tk = mapTk(String(r["Ticker"]));
    nativeBy[tk] = String(r["Currency"] || "USD");
    const p = byTicker[tk] || (byTicker[tk] = { qty: 0, cost: 0 });
    const qty = parseFloat(String(r["Quantity"])) || 0;
    const fx = parseFloat(String(r["FX Rate"])) || 1;
    const [, totVal] = parseAmt(r["Total Amount"]);
    const type = String(r["Type"]);
    if (type === "BUY - MARKET") {
      p.cost += (totVal || 0) / (fx || 1);
      p.qty += qty;
    } else if (type === "SELL - MARKET" || type === "BOND REDEMPTION") {
      // A redeemed bond leaves the account like a sale at its redemption value.
      const avg = p.qty > 1e-9 ? p.cost / p.qty : 0;
      const proceeds = (totVal || 0) / (fx || 1);
      realizedBy[tk] = (realizedBy[tk] || 0) + (proceeds - avg * qty);
      p.qty -= qty;
      p.cost = p.qty > 1e-9 ? avg * p.qty : 0;
    } else if (type === "STOCK SPLIT") {
      p.qty += qty;
    }
  }

  const incomeBy: Record<string, { dividend: number; coupon: number }> = {};
  for (const r of rows) {
    if (!r["Ticker"]) continue;
    const tk = mapTk(String(r["Ticker"]));
    const fx = parseFloat(String(r["FX Rate"])) || 1;
    const [, totVal] = parseAmt(r["Total Amount"]);
    const eur = (totVal || 0) / (fx || 1);
    const t = String(r["Type"]);
    if (t === "DIVIDEND" || t === "DIVIDEND TAX (CORRECTION)") {
      (incomeBy[tk] || (incomeBy[tk] = { dividend: 0, coupon: 0 })).dividend += eur;
    } else if (t === "BOND COUPON") {
      (incomeBy[tk] || (incomeBy[tk] = { dividend: 0, coupon: 0 })).coupon += eur;
    }
  }

  const positions: ParsedPosition[] = [];
  for (const [tk, p] of Object.entries(byTicker)) {
    if (p.qty <= 1e-6) continue;
    const bond = isISIN(tk);
    positions.push({
      ticker: tk,
      name: tk,
      platform: "revolut",
      asset_type: bond ? "bond" : "stock",
      quantity: p.qty,
      avg_buy_price: p.cost / p.qty,
      buy_currency: "EUR",
      native_currency: nativeBy[tk] || "USD",
      manual_price: bond,
    });
  }

  const realized: ParsedRealized[] = [];
  for (const [tk, rz] of Object.entries(realizedBy)) {
    if (Math.abs(rz) >= 0.01)
      realized.push({ ticker: tk, platform: "revolut", kind: "sale", realized_eur: rz });
  }
  for (const [tk, inc] of Object.entries(incomeBy)) {
    if (Math.abs(inc.dividend) >= 0.01)
      realized.push({ ticker: tk, platform: "revolut", kind: "dividend", realized_eur: inc.dividend });
    if (Math.abs(inc.coupon) >= 0.01)
      realized.push({ ticker: tk, platform: "revolut", kind: "coupon", realized_eur: inc.coupon });
  }
  return { positions, realized, notes: [] };
}

// Moves between the user's own wallets on Crypto.com (staking lock-ups, Earn, Supercharger).
// The coins never leave the account, so they change neither the quantity held nor its cost.
const INTERNAL_KIND = /lockup|crypto_earn_program_(created|withdrawn)|supercharger_(deposit|withdrawal)/;

/**
 * Crypto.com statement → positions at average cost.
 *
 * Pass the rows of EVERY statement of the account, oldest to newest in any order: a statement
 * read alone starts from zero and gives wrong quantities and costs for anything bought before it.
 *
 * `usdToEur` converts the rows whose "Native Amount" is in USD. Without it they count 1:1.
 */
export function parseCryptoCom(
  rows: Record<string, unknown>[],
  usdToEur: FxLookup = () => 1,
): ParseResult {
  const SALE_KINDS = new Set([
    "card_top_up",
    "crypto_viban_exchange",
    "crypto_exchange",
    "dust_conversion_debited",
    "viban_purchase",
    "crypto_wallet_swap_debited",
  ]);

  const sorted = [...rows].sort(
    (a, b) =>
      new Date(String(a["Timestamp (UTC)"])).getTime() -
      new Date(String(b["Timestamp (UTC)"])).getTime()
  );

  const byCur: Record<string, { qty: number; cost: number }> = {};
  const realizedBy: Record<string, { sale: number; transfer: number }> = {};
  const shortfall: Record<string, number> = {};
  const otherNative = new Set<string>();

  const acquire = (cur: string, qty: number, costEur: number) => {
    const p = byCur[cur] || (byCur[cur] = { qty: 0, cost: 0 });
    p.qty += qty;
    p.cost += costEur;
  };

  for (const r of sorted) {
    const kind = r["Transaction Kind"] ? String(r["Transaction Kind"]) : "";
    if (INTERNAL_KIND.test(kind)) continue;

    const cur = r["Currency"] ? String(r["Currency"]) : "";
    const amt = parseFloat(String(r["Amount"]));
    const toCur = r["To Currency"] ? String(r["To Currency"]) : "";
    const toAmt = parseFloat(String(r["To Amount"]));
    const natCur = r["Native Currency"] ? String(r["Native Currency"]) : "EUR";
    const natRaw = parseFloat(String(r["Native Amount"]));
    if (natCur !== "EUR" && natCur !== "USD") otherNative.add(natCur);
    // Value of the row in EUR. The sign of "Native Amount" is not consistent across kinds.
    const value = isNaN(natRaw)
      ? NaN
      : Math.abs(natRaw) * (natCur === "USD" ? usdToEur(String(r["Timestamp (UTC)"])) : 1);

    // 1. The "Currency" leg: a coin received (amount > 0) or given up (amount < 0).
    if (cur && cur !== "EUR" && !isNaN(amt)) {
      if (amt > 0) {
        acquire(cur, amt, isNaN(value) ? 0 : value);
      } else if (amt < 0) {
        const p = byCur[cur] || (byCur[cur] = { qty: 0, cost: 0 });
        const out = Math.abs(amt);
        const avg = p.qty > 1e-12 ? p.cost / p.qty : 0;
        // More going out than the statements show coming in: the history is incomplete.
        // Never let the quantity go negative, or later purchases get a wildly inflated cost.
        const known = Math.min(out, Math.max(p.qty, 0));
        if (out - known > 1e-9) shortfall[cur] = (shortfall[cur] || 0) + (out - known);
        const proceeds = isNaN(value) ? avg * out : value;
        const rz = proceeds - avg * known;
        const bucket: "sale" | "transfer" = SALE_KINDS.has(kind) ? "sale" : "transfer";
        const rb = realizedBy[cur] || (realizedBy[cur] = { sale: 0, transfer: 0 });
        rb[bucket] += rz;
        p.qty -= known;
        p.cost = p.qty > 1e-12 ? avg * p.qty : 0;
      }
    }

    // 2. The "To Currency" leg: what an exchange or a fiat purchase delivered (USDT > BTC,
    //    EUR > CRO). Its cost is the value of the row. A transfer credit repeats the same
    //    coin with the opposite sign there: that is not a second leg.
    if (toCur && toCur !== "EUR" && toCur !== cur && toAmt > 0) {
      acquire(toCur, toAmt, isNaN(value) ? 0 : value);
    }
  }

  const positions: ParsedPosition[] = [];
  for (const [cur, p] of Object.entries(byCur)) {
    if (p.qty <= 1e-8) continue;
    positions.push({
      ticker: cur,
      name: cur,
      platform: "crypto.com",
      asset_type: "crypto",
      quantity: p.qty,
      avg_buy_price: p.cost / p.qty,
      buy_currency: "EUR",
      native_currency: "USD",
      manual_price: false,
    });
  }

  const realized: ParsedRealized[] = [];
  for (const [cur, rb] of Object.entries(realizedBy)) {
    if (Math.abs(rb.sale) >= 0.01)
      realized.push({ ticker: cur, platform: "crypto.com", kind: "sale", realized_eur: rb.sale });
    if (Math.abs(rb.transfer) >= 0.01)
      realized.push({ ticker: cur, platform: "crypto.com", kind: "transfer", realized_eur: rb.transfer });
  }

  const notes: string[] = [];
  const short = Object.entries(shortfall).filter(([, q]) => q > 1e-8);
  if (short.length > 0) {
    notes.push(
      `History looks incomplete for ${short.map(([c]) => c).join(", ")}: more went out than these ` +
        `statements show coming in. Select every statement of the account, from the first one.`
    );
  }
  if (otherNative.size > 0) {
    notes.push(`Amounts in ${[...otherNative].join(", ")} were counted as EUR 1:1.`);
  }
  return { positions, realized, notes };
}

/**
 * USD → EUR rates for the dates given (ECB reference rates via frankfurter.dev, one request).
 * If the rates cannot be loaded, falls back to `fallbackRate` for every date and says so.
 */
export async function loadUsdEurRates(
  isoDates: string[],
  fallbackRate = 0.92,
): Promise<{ lookup: FxLookup; approximate: boolean }> {
  const days = [...new Set(isoDates.map((d) => d.slice(0, 10)))].sort();
  if (days.length === 0) return { lookup: () => fallbackRate, approximate: false };
  try {
    const res = await fetch(
      `https://api.frankfurter.dev/v1/${days[0]}..${days[days.length - 1]}?base=USD&symbols=EUR`
    );
    if (!res.ok) throw new Error(`rates: HTTP ${res.status}`);
    const json = (await res.json()) as { rates?: Record<string, { EUR?: number }> };
    const series = Object.entries(json.rates ?? {})
      .map(([d, v]) => [d, v.EUR] as [string, number | undefined])
      .filter((e): e is [string, number] => typeof e[1] === "number")
      .sort((a, b) => (a[0] < b[0] ? -1 : 1));
    if (series.length === 0) throw new Error("rates: empty");
    const lookup: FxLookup = (iso) => {
      const day = iso.slice(0, 10);
      // Rates exist for business days only: use the last one on or before the date.
      let rate = series[0][1];
      for (const [d, v] of series) {
        if (d > day) break;
        rate = v;
      }
      return rate;
    };
    return { lookup, approximate: false };
  } catch {
    return { lookup: () => fallbackRate, approximate: true };
  }
}

/** Reads one statement file into rows keyed by column header. */
export async function readFileRows(file: File): Promise<Record<string, unknown>[]> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".csv")) {
    const Papa = (await import("papaparse")).default;
    const text = await file.text();
    const out = Papa.parse<Record<string, unknown>>(text, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: false,
    });
    return out.data;
  }
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
    const XLSX = await import("xlsx");
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: "" });
  }
  throw new Error("Unsupported file type. Use .csv or .xlsx");
}

/** Reads several statements of the same platform and drops rows that appear in more than one. */
export async function readStatements(files: File[]): Promise<Record<string, unknown>[]> {
  const seenInEarlierFiles = new Set<string>();
  const all: Record<string, unknown>[] = [];
  for (const f of files) {
    const keys: string[] = [];
    for (const row of await readFileRows(f)) {
      const key = JSON.stringify(row);
      keys.push(key);
      // Two identical rows inside one statement are two real transactions: keep both.
      if (seenInEarlierFiles.has(key)) continue;
      all.push(row);
    }
    for (const k of keys) seenInEarlierFiles.add(k);
  }
  return all;
}
