// Real parsers for Revolut (.xlsx) and Crypto.com (.csv).
// Each returns { positions, realized }.

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
};

export type Source = "revolut" | "crypto.com";

function parseAmt(s: unknown): [string | null, number | null] {
  if (s == null) return [null, null];
  const m = String(s).match(/([A-Z]{3})\s*(-?[\d.]+)/);
  return m ? [m[1], parseFloat(m[2])] : [null, null];
}

function isISIN(t: string | null | undefined): boolean {
  return /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(t || "");
}

export function parseRevolut(rows: Record<string, unknown>[]): ParseResult {
  const TICKER_MAP: Record<string, string> = { DHL: "DHL.DE" };
  const mapTk = (t: string) => TICKER_MAP[t] || t;

  const trades = rows
    .filter(
      (r) =>
        ["BUY - MARKET", "SELL - MARKET", "STOCK SPLIT"].includes(String(r["Type"])) &&
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
    const p = byTicker[tk] || (byTicker[tk] = { qty: 0, cost: 0 });
    const qty = parseFloat(String(r["Quantity"])) || 0;
    const fx = parseFloat(String(r["FX Rate"])) || 1;
    const [, totVal] = parseAmt(r["Total Amount"]);
    const type = String(r["Type"]);
    if (type === "BUY - MARKET") {
      p.cost += (totVal || 0) / (fx || 1);
      p.qty += qty;
    } else if (type === "SELL - MARKET") {
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
      native_currency: bond ? "EUR" : "USD",
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
  return { positions, realized };
}

export function parseCryptoCom(rows: Record<string, unknown>[]): ParseResult {
  const SALE_KINDS = new Set([
    "card_top_up",
    "crypto_viban_exchange",
    "crypto_exchange",
    "dust_conversion_debited",
    "viban_purchase",
  ]);

  const sorted = [...rows].sort(
    (a, b) =>
      new Date(String(a["Timestamp (UTC)"])).getTime() -
      new Date(String(b["Timestamp (UTC)"])).getTime()
  );

  const byCur: Record<string, { qty: number; cost: number }> = {};
  const realizedBy: Record<string, { sale: number; transfer: number }> = {};
  for (const r of sorted) {
    const cur = r["Currency"] ? String(r["Currency"]) : "";
    const amt = parseFloat(String(r["Amount"]));
    const nat = parseFloat(String(r["Native Amount"]));
    const kind = r["Transaction Kind"] ? String(r["Transaction Kind"]) : "";
    if (!cur || cur === "EUR" || isNaN(amt)) continue;
    const p = byCur[cur] || (byCur[cur] = { qty: 0, cost: 0 });
    if (amt > 0) {
      p.cost += isNaN(nat) ? 0 : nat;
      p.qty += amt;
    } else {
      const avg = p.qty > 1e-12 ? p.cost / p.qty : 0;
      const proceeds = isNaN(nat) ? avg * Math.abs(amt) : Math.abs(nat);
      const rz = proceeds - avg * Math.abs(amt);
      const bucket: "sale" | "transfer" = SALE_KINDS.has(kind) ? "sale" : "transfer";
      const rb = realizedBy[cur] || (realizedBy[cur] = { sale: 0, transfer: 0 });
      rb[bucket] += rz;
      p.qty += amt;
      p.cost = p.qty > 1e-12 ? avg * p.qty : 0;
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
  return { positions, realized };
}

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
