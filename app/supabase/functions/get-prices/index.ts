

const CG_IDS: Record<string, string> = {
  BTC: "bitcoin", ETH: "ethereum", CRO: "crypto-com-chain",
  SOL: "solana", ADA: "cardano", DOGE: "dogecoin", USDT: "tether",
  UNI: "uniswap", MANA: "decentraland", ENJ: "enjincoin", APE: "apecoin",
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { positions } = await req.json();
    console.log(`[get-prices] received ${positions?.length ?? 0} positions`);
    const prices: Record<string, unknown> = {};

    let eurusd = 1, eurgbp = 1;
    try {
      const fx = await fetch("https://api.frankfurter.app/latest?base=EUR&symbols=USD,GBP");
      console.log(`[fx] status=${fx.status}`);
      const fxj = await fx.json();
      eurusd = fxj?.rates?.USD || 1;
      eurgbp = fxj?.rates?.GBP || 1;
      console.log(`[fx] eurusd=${eurusd} eurgbp=${eurgbp}`);
    } catch (_) { /* keep defaults */ }

    const toEUR = (price: number, cur: string) => {
      if (cur === "EUR") return price;
      if (cur === "GBP") return price / eurgbp;
      return price / eurusd;
    };

    const cryptos = positions.filter((p: any) => p.asset_type === "crypto" && !p.manual_price);
    const ids = [...new Set(cryptos.map((p: any) => CG_IDS[p.ticker]).filter(Boolean))];
    if (ids.length) {
      try {
        const cg = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=usd`);
        console.log(`[coingecko] status=${cg.status} ids=${ids.join(",")}`);
        const cgj = await cg.json();
        for (const p of cryptos) {
          const id = CG_IDS[p.ticker];
          const usd = id ? cgj?.[id]?.usd : undefined;
          prices[p.ticker] = usd != null
            ? { price_native: usd, native_currency: "USD", price_eur: toEUR(usd, "USD"), source: "coingecko" }
            : { error: "id not mapped", source: "coingecko" };
        }
      } catch (e) { for (const p of cryptos) prices[p.ticker] = { error: String(e), source: "coingecko" }; }
    }

    const stocks = positions.filter((p: any) => (p.asset_type === "stock" || p.asset_type === "etf") && !p.manual_price);
    for (const p of stocks) {
      try {
        const y = await fetch(
          `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(p.ticker)}`,
          {
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
              "Accept": "*/*",
              "Accept-Language": "en-US,en;q=0.9",
              "Referer": "https://finance.yahoo.com",
            },
          }
        );
        const yj = await y.json();
        const meta = yj?.chart?.result?.[0]?.meta;
        const price = meta?.regularMarketPrice;
        const cur = meta?.currency || "USD";
        console.log(`[yahoo] ${p.ticker} status=${y.status} price=${price ?? "none"}`);
        prices[p.ticker] = price != null
          ? { price_native: price, native_currency: cur, price_eur: toEUR(price, cur), source: "yahoo" }
          : { error: "no price (check ticker)", source: "yahoo" };
      } catch (e) { prices[p.ticker] = { error: String(e), source: "yahoo" }; }
      await sleep(120);
    }

    return new Response(JSON.stringify({ eurusd, eurgbp, prices }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
