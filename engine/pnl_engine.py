"""
P&L Engine + TWR Calculator — Investment Portfolio Tracker
==========================================================
Compatibile con la struttura: tab DATI, PORTFOLIO EDO, PORTFOLIO FEDE
Colonne attese in DATI: Ticker, Nome, Quantità, Prezzo Carico, Prezzo Attuale,
                         Controvalore, Gain/Loss €, Gain/Loss %, Valuta, Settore

Uso rapido:
    python pnl_engine.py                          # usa file di default
    python pnl_engine.py --file mio_tracker.xlsx  # file custom
    python pnl_engine.py --portfolio fede         # solo portfolio Fede
    python pnl_engine.py --live                   # aggiorna prezzi live da yfinance
"""

import argparse
import sys
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import yfinance as yf

# ─── Configurazione ────────────────────────────────────────────────────────────

# Stesso default della dashboard: il tracker in ../data/ (cartella non versionata)
DEFAULT_FILE = str(Path(__file__).parent.parent / "data" / "INVESTMENT PORTFOLIO TRACKER (3).xlsx")

# Mappa nomi colonne attesi → possibili varianti nel file reale
# Modifica qui se i tuoi header sono diversi
COL_MAP = {
    "ticker":         ["Ticker", "ticker", "TICKER", "Symbol"],
    "nome":           ["Nome", "Name", "Titolo"],
    "quantita":       ["Quote (Qty)", "Quantità", "Quantita", "Qty", "Shares"],
    "prezzo_carico":  ["PMC ", "PMC", "Prezzo Carico", "Prezzo medio carico", "Avg Cost"],
    "prezzo_attuale": ["Prezzo Attuale", "Prezzo Attuale $", "Prezzo", "Last Price", "Prezzo Corrente"],
    "valuta":         ["Valuta", "Ccy", "Currency", "CCY"],
    "settore":        ["Settore", "Sector"],
    "controvalore":   ["Valore Totale", "Controvalore", "Market Value", "Valore"],
}

# Fogli portfolio — chiave = nome sheet, valore = label display
PORTFOLIO_SHEETS = {
    "PORTFOLIO EDO": "Edoardo",
    "PORTFOLIO FEDE": "Federico",
}

# Tassi fallback verso EUR usati se yfinance non risponde
FX_FALLBACK_TO_EUR: dict[str, float] = {
    "USD": 0.92,
    "GBP": 1.17,
    "CHF": 1.05,
    "JPY": 0.0062,
}

# Valuta nativa per exchange prefix (fallback senza yfinance)
EXCHANGE_CCY: dict[str, str] = {
    "NASDAQ":   "USD",
    "NYSE":     "USD",
    "CURRENCY": "USD",
    "ETR":      "EUR",
    "EPA":      "EUR",
    "AMS":      "EUR",
    "SWX":      "CHF",
    "LON":      "GBP",
}
# Suffissi crypto → sempre USD
CRYPTO_USD_SUFFIXES = ("USD", "USDT", "USDC")

# ─── Ticker normalizer ─────────────────────────────────────────────────────────

def clean_ticker_for_yfinance(ticker: str) -> str:
    """Converte ticker con prefisso exchange nel formato yfinance."""
    crypto_map = {
        "CURRENCY:BTCUSD": "BTC-USD",
        "ETHUSD":  "ETH-USD",
        "SOLUSD":  "SOL-USD",
        "DOGEUSD": "DOGE-USD",
        "SHIBUSD": "SHIB-USD",
        "CROUSD":  "CRO-USD",
        "BTCUSD":  "BTC-USD",
    }
    commodity_map = {
        "COMEX:GCW00": "GC=F",
        "GCW00":       "GC=F",
    }
    exchange_suffix = {
        "NASDAQ": "",
        "NYSE":   "",
        "ETR":    ".DE",
        "SWX":    ".SW",
        "LON":    ".L",
        "EPA":    ".PA",
        "AMS":    ".AS",
    }

    t = ticker.strip().upper()

    if t in crypto_map:
        return crypto_map[t]
    if t in commodity_map:
        return commodity_map[t]

    if ":" in t:
        exchange, symbol = t.split(":", 1)
        if f"{exchange}:{symbol}" in commodity_map:
            return commodity_map[f"{exchange}:{symbol}"]
        suffix = exchange_suffix.get(exchange, "")
        return symbol + suffix

    return t




# ─── Utility ───────────────────────────────────────────────────────────────────

def resolve_col(df: pd.DataFrame, key: str) -> str | None:
    """Trova il nome colonna reale nel DataFrame dato un alias."""
    for candidate in COL_MAP.get(key, []):
        if candidate in df.columns:
            return candidate
    return None


def require_col(df: pd.DataFrame, key: str, context: str = "") -> str:
    col = resolve_col(df, key)
    if col is None:
        hint = f" (cercavo una di: {COL_MAP[key]})"
        raise KeyError(f"[{context}] Colonna '{key}' non trovata{hint}. "
                       f"Colonne presenti: {list(df.columns)}")
    return col


def fmt_eur(v: float) -> str:
    sign = "+" if v >= 0 else ""
    return f"{sign}€{v:,.2f}"


def fmt_pct(v: float) -> str:
    sign = "+" if v >= 0 else ""
    return f"{sign}{v:.2f}%"


def fmt_px(v: float) -> str:
    """Prezzo unitario: 2 decimali, ma abbastanza cifre per i token che valgono frazioni di centesimo."""
    return f"{v:.2f}" if abs(v) >= 0.01 or v == 0 else f"{v:.3g}"


def color(v: float, text: str) -> str:
    """Aggiunge ANSI color: verde positivo, rosso negativo."""
    if v > 0:
        return f"\033[92m{text}\033[0m"
    elif v < 0:
        return f"\033[91m{text}\033[0m"
    return text


# ─── Lettura dati ──────────────────────────────────────────────────────────────

def load_portfolio(path: str, sheet: str) -> pd.DataFrame:
    """
    Legge il foglio portfolio e normalizza le colonne chiave.
    Rimuove righe senza ticker o con ticker = totale/header.
    """
    df = pd.read_excel(path, sheet_name=sheet, engine="openpyxl")

    # Rimuovi righe completamente vuote
    df = df.dropna(how="all")

    # Trova colonna ticker
    ticker_col = require_col(df, "ticker", sheet)

    # Rimuovi righe che non sono posizioni reali (totali, separatori, ecc.)
    df = df[
        df[ticker_col].notna() &
        df[ticker_col].astype(str).str.strip().ne("") &
        ~df[ticker_col].astype(str).str.lower().str.contains("total|totale|cash|------", na=False)
    ].copy()

    df[ticker_col] = df[ticker_col].astype(str).str.strip().str.upper()
    df = df.reset_index(drop=True)
    return df


def get_fx_rate(from_ccy: str, to_ccy: str = "EUR") -> float:
    """Recupera tasso di cambio live da yfinance."""
    from_ccy = from_ccy.upper().strip()
    to_ccy   = to_ccy.upper().strip()
    if from_ccy == to_ccy:
        return 1.0
    try:
        pair = f"{from_ccy}{to_ccy}=X"
        fi = yf.Ticker(pair).fast_info
        for attr in ("last_price", "regular_market_price"):
            val = getattr(fi, attr, None)
            if val is not None and not (isinstance(val, float) and val != val):
                return float(val)
    except Exception:
        pass
    # Fallback: prima EUR→from, poi inversione se serve
    if to_ccy == "EUR":
        return FX_FALLBACK_TO_EUR.get(from_ccy, 1.0)
    if from_ccy == "EUR":
        rate = FX_FALLBACK_TO_EUR.get(to_ccy)
        return 1.0 / rate if rate else 1.0
    # Triangolazione via EUR
    src = FX_FALLBACK_TO_EUR.get(from_ccy, 1.0)
    dst = FX_FALLBACK_TO_EUR.get(to_ccy, 1.0)
    return src / dst if dst else 1.0


def guess_currency_from_ticker(ticker_raw: str) -> str:
    """Deduce la valuta del ticker dal prefisso exchange o dal suffisso crypto."""
    t = ticker_raw.strip().upper()
    # Crypto con suffisso USD
    for suffix in CRYPTO_USD_SUFFIXES:
        if t.endswith(suffix) and t != suffix:
            return "USD"
    # Exchange prefix esplicito
    if ":" in t:
        exchange = t.split(":")[0]
        return EXCHANGE_CCY.get(exchange, "USD")
    # Suffisso borsa implicito (es. DHL.DE → EUR, NESN.SW → CHF)
    if t.endswith(".DE") or t.endswith(".PA") or t.endswith(".AS"):
        return "EUR"
    if t.endswith(".SW"):
        return "CHF"
    if t.endswith(".L"):
        return "GBP"
    # Default: assume USD (la maggior parte dei ticker senza prefisso è NASDAQ/NYSE)
    return "USD"


# ─── P&L Giornaliero ───────────────────────────────────────────────────────────

def fetch_live_data(ticker_yf: str) -> tuple[float | None, str | None]:
    """Recupera prezzo live e valuta da yfinance. Ritorna (price, currency)."""
    price: float | None = None
    currency: str | None = None
    try:
        fi = yf.Ticker(ticker_yf).fast_info
        for attr in ("last_price", "regular_market_price"):
            val = getattr(fi, attr, None)
            if val is not None and not (isinstance(val, float) and val != val):
                price = float(val)
                break
        ccy = getattr(fi, "currency", None)
        if isinstance(ccy, str) and ccy.strip():
            currency = ccy.upper().strip()
    except Exception:
        pass
    if price is None:
        try:
            hist = yf.download(ticker_yf, period="2d", progress=False, auto_adjust=True)
            if not hist.empty:
                closes = hist["Close"].dropna()
                if not closes.empty:
                    price = float(closes.iloc[-1])
        except Exception:
            pass
    return price, currency


def compute_pnl(df: pd.DataFrame, label: str, use_live: bool = True) -> pd.DataFrame:
    """
    Calcola P&L per ogni posizione:
    - P&L non realizzato = (Prezzo Attuale - Prezzo Carico) × Quantità
    - P&L % = (Prezzo Attuale / Prezzo Carico - 1) × 100
    - Tutto normalizzato in EUR
    """
    t_col  = require_col(df, "ticker", label)
    q_col  = require_col(df, "quantita", label)
    pc_col = require_col(df, "prezzo_carico", label)
    pa_col = require_col(df, "prezzo_attuale", label)

    # Colonne opzionali
    v_col  = resolve_col(df, "valuta")
    s_col  = resolve_col(df, "settore")
    n_col  = resolve_col(df, "nome")

    result = pd.DataFrame()
    result["ticker"]   = df[t_col]
    result["nome"]     = df[n_col] if n_col else result["ticker"]
    result["settore"]  = df[s_col] if s_col else "N/D"
    # Valuta: colonna dal file se presente, altrimenti deduciamo dal ticker
    if v_col:
        result["valuta"] = df[v_col].fillna("EUR").astype(str).str.upper().str.strip()
    else:
        result["valuta"] = result["ticker"].apply(guess_currency_from_ticker)

    result["quantita"] = pd.to_numeric(df[q_col], errors="coerce").fillna(0)
    result["prezzo_carico"]  = pd.to_numeric(df[pc_col], errors="coerce").fillna(0)
    result["prezzo_attuale"] = pd.to_numeric(df[pa_col], errors="coerce").fillna(0)

    # Controllo di coerenza sul prezzo del file: se Qty × Prezzo non torna con il "Valore Totale"
    # del foglio (es. controvalore scritto a mano nella cella del prezzo), il prezzo unitario
    # viene ricavato dal totale. Senza questo controllo una sola riga sbagliata falsa tutto il portfolio.
    cv_col = resolve_col(df, "controvalore")
    if cv_col:
        sheet_total = pd.to_numeric(df[cv_col], errors="coerce")
        implied = result["quantita"] * result["prezzo_attuale"]
        bad = (sheet_total.notna() & (sheet_total > 0) & (result["quantita"] > 0)
               & ((implied - sheet_total).abs() > 0.05 * sheet_total))
        for idx in result.index[bad]:
            fixed = float(sheet_total[idx]) / float(result.at[idx, "quantita"])
            print(f"  [warn] {result.at[idx, 'ticker']} — prezzo nel file ({result.at[idx, 'prezzo_attuale']:g}) "
                  f"incoerente con il Valore Totale ({sheet_total[idx]:g}): uso {fixed:g}")
            result.at[idx, "prezzo_attuale"] = fixed

    # Aggiornamento prezzi live + valuta da yfinance
    if use_live:
        print(f"  Aggiornamento prezzi live per {label}...")
        for idx, row in result.iterrows():
            clean_tk = clean_ticker_for_yfinance(row["ticker"])
            price, currency = fetch_live_data(clean_tk)
            if price is not None:
                result.at[idx, "prezzo_attuale"] = price
            else:
                print(f"  [warn] {row['ticker']} — prezzo non disponibile, uso valore dal file")
            if currency is not None:
                result.at[idx, "valuta"] = currency

    # FX → EUR
    fx_cache = {}
    def to_eur(row):
        ccy = str(row["valuta"]).upper().strip()
        if ccy not in fx_cache:
            fx_cache[ccy] = get_fx_rate(ccy)
        return fx_cache[ccy]

    result["fx_rate"] = result.apply(to_eur, axis=1)

    # Calcoli P&L
    result["costo_totale_eur"]    = result["quantita"] * result["prezzo_carico"]  * result["fx_rate"]
    result["valore_attuale_eur"]  = result["quantita"] * result["prezzo_attuale"] * result["fx_rate"]
    result["pnl_eur"]             = result["valore_attuale_eur"] - result["costo_totale_eur"]
    result["pnl_pct"]             = np.where(
        result["costo_totale_eur"] != 0,
        (result["pnl_eur"] / result["costo_totale_eur"]) * 100,
        0.0
    )

    # Peso % nel portfolio
    total_val = result["valore_attuale_eur"].sum()
    result["peso_pct"] = np.where(
        total_val > 0,
        (result["valore_attuale_eur"] / total_val) * 100,
        0.0
    )

    return result.sort_values("pnl_eur", ascending=False).reset_index(drop=True)


# ─── Conversione valuta di visualizzazione ─────────────────────────────────────

CURRENCY_SYMBOLS: dict[str, str] = {
    "EUR": "€", "USD": "$", "CHF": "Fr.", "GBP": "£", "JPY": "¥",
}


def apply_display_currency(pnl_df: pd.DataFrame, target_ccy: str = "EUR") -> pd.DataFrame:
    """
    Riesprime prezzi e totali nella valuta di visualizzazione richiesta.

    Input atteso: DataFrame prodotto da compute_pnl() — colonne richieste:
      `prezzo_carico`, `prezzo_attuale` (in valuta nativa),
      `fx_rate` (native→EUR),
      `costo_totale_eur`, `valore_attuale_eur`, `pnl_eur`, `valuta`.

    Output: copia con colonne `prezzo_carico`/`prezzo_attuale` espresse in
    `target_ccy`, totali rinominati senza suffisso (`costo_totale`,
    `valore_attuale`, `pnl`), più `display_currency`, `display_symbol`,
    `valuta_nativa`. `pnl_pct` e `peso_pct` restano invariati.
    """
    target_ccy = (target_ccy or "EUR").upper().strip()

    # Tasso EUR → target: get_fx_rate dà target→EUR, invertiamo
    if target_ccy == "EUR":
        eur_to_target = 1.0
    else:
        target_to_eur = get_fx_rate(target_ccy, "EUR")
        eur_to_target = 1.0 / target_to_eur if target_to_eur else 1.0

    # native → target = (native → EUR) * (EUR → target)
    native_to_target = pnl_df["fx_rate"] * eur_to_target

    out = pnl_df.copy()
    out["valuta_nativa"]    = pnl_df["valuta"]
    out["display_currency"] = target_ccy
    out["display_symbol"]   = CURRENCY_SYMBOLS.get(target_ccy, target_ccy)
    out["prezzo_carico"]    = pnl_df["prezzo_carico"]  * native_to_target
    out["prezzo_attuale"]   = pnl_df["prezzo_attuale"] * native_to_target
    out["costo_totale"]     = pnl_df["costo_totale_eur"]   * eur_to_target
    out["valore_attuale"]   = pnl_df["valore_attuale_eur"] * eur_to_target
    out["pnl"]              = pnl_df["pnl_eur"] * eur_to_target

    # Drop colonne EUR ridondanti: nel flusso dashboard si ragiona in display ccy
    return out.drop(columns=["costo_totale_eur", "valore_attuale_eur", "pnl_eur"])


# ─── TWR (Time-Weighted Return) ────────────────────────────────────────────────

def compute_twr_from_history(ticker: str, qty: float, avg_cost: float,
                             valuta: str = "EUR", periods: int = 252) -> dict:
    """
    Calcola TWR approssimato per una singola posizione usando dati storici yfinance.

    TWR = ∏(1 + r_t) - 1
    dove r_t = rendimento del sub-periodo t (giornaliero)

    Con un solo prezzo di carico (senza data acquisto precisa), approssimiamo
    usando la serie storica e normalizzando al prezzo di carico.
    """
    empty = {"ticker": ticker, "twr_1m": None, "twr_3m": None, "twr_6m": None, "twr_ytd": None,
             "twr_1y": None, "pnl_abs_eur": None, "pnl_pct": None}
    try:
        # yfinance vuole il simbolo nel suo formato (AMD, DHL.DE, BTC-USD), non quello del foglio
        # 2 anni di storico: "252d" copriva un anno solo per le azioni; le crypto quotano 365 giorni l'anno
        hist = yf.Ticker(clean_ticker_for_yfinance(ticker)).history(period="2y", auto_adjust=True)
        if hist.empty or len(hist) < 2:
            return {**empty, "error": "no data"}

        closes = hist["Close"].dropna()
        fx = get_fx_rate(valuta)

        # Rendimenti giornalieri
        daily_returns = closes.pct_change().dropna()

        # TWR = prodotto dei (1 + r_t) - 1
        today = closes.index[-1].date()

        def twr_window(days: int) -> float | None:
            cutoff = today - timedelta(days=days)
            window = daily_returns[daily_returns.index.date >= cutoff]
            if len(window) == 0:
                return None
            return float(np.prod(1 + window) - 1) * 100

        # P&L non realizzato attuale
        current_price = float(closes.iloc[-1])
        pnl_abs = (current_price - avg_cost) * qty * fx
        pnl_pct = ((current_price / avg_cost) - 1) * 100 if avg_cost > 0 else 0.0

        return {
            "ticker":    ticker,
            "twr_1m":    twr_window(30),
            "twr_3m":    twr_window(90),
            "twr_6m":    twr_window(180),
            "twr_ytd":   twr_window((today - today.replace(month=1, day=1)).days),
            "twr_1y":    twr_window(365),
            "pnl_abs_eur": pnl_abs,
            "pnl_pct":   pnl_pct,
            "error":     None,
        }
    except Exception as e:
        return {**empty, "error": str(e)}


def compute_portfolio_twr(pnl_df: pd.DataFrame, label: str) -> pd.DataFrame:
    """
    TWR a livello portfolio (weighted average dei TWR individuali,
    pesati per valore attuale EUR).

    Per ogni posizione recupera la serie storica da yfinance.
    """
    print(f"\n  Calcolo TWR per {label} (recupero dati storici da yfinance)...")
    rows = []
    total = len(pnl_df)

    for i, row in pnl_df.iterrows():
        ticker = row["ticker"]
        print(f"    [{i+1}/{total}] {ticker}...", end="\r")
        res = compute_twr_from_history(
            ticker=ticker,
            qty=row["quantita"],
            avg_cost=row["prezzo_carico"],
            valuta=row["valuta"],
        )
        res["peso_pct"] = row["peso_pct"]
        res["valore_eur"] = row["valore_attuale_eur"]
        rows.append(res)

    print()  # newline dopo i progressi
    twr_df = pd.DataFrame(rows)
    return twr_df


def portfolio_twr_summary(twr_df: pd.DataFrame) -> dict:
    """
    TWR aggregato del portfolio = media pesata (per valore) dei TWR individuali.
    Esclude le posizioni senza dati.
    """
    summary = {}
    for period in ["twr_1m", "twr_3m", "twr_6m", "twr_ytd", "twr_1y"]:
        valid = twr_df[twr_df[period].notna()].copy()
        if valid.empty:
            summary[period] = None
            continue
        total_val = valid["valore_eur"].sum()
        if total_val == 0:
            summary[period] = None
            continue
        weights = valid["valore_eur"] / total_val
        summary[period] = float((weights * valid[period]).sum())
    return summary


# ─── Output ────────────────────────────────────────────────────────────────────

def print_pnl_table(pnl_df: pd.DataFrame, label: str):
    sep = "─" * 90
    print(f"\n{'═'*90}")
    print(f"  PORTFOLIO {label.upper()}  —  P&L Snapshot  ({datetime.now().strftime('%d/%m/%Y %H:%M')})")
    print(f"{'═'*90}")
    print(f"  {'TICKER':<16} {'NOME':<22} {'QTY':>10} {'P.CARICO':>10} "
          f"{'P.ATT.':>10} {'VAL.EUR':>12} {'P&L EUR':>12} {'P&L %':>8} {'PESO':>6}")
    print(f"  {sep}")

    for _, row in pnl_df.iterrows():
        pnl_str  = fmt_eur(row["pnl_eur"])
        pct_str  = fmt_pct(row["pnl_pct"])
        print(
            f"  {row['ticker']:<16} "
            f"{str(row['nome'])[:22]:<22} "
            f"{row['quantita']:>10.4g} "
            f"{fmt_px(row['prezzo_carico']):>10} "
            f"{fmt_px(row['prezzo_attuale']):>10} "
            f"€{row['valore_attuale_eur']:>11,.0f} "
            f"{color(row['pnl_eur'], f'{pnl_str:>12}')} "
            f"{color(row['pnl_pct'], f'{pct_str:>8}')} "
            f"{row['peso_pct']:>5.1f}%"
        )

    print(f"  {sep}")
    total_val  = pnl_df["valore_attuale_eur"].sum()
    total_cost = pnl_df["costo_totale_eur"].sum()
    total_pnl  = pnl_df["pnl_eur"].sum()
    total_pct  = (total_pnl / total_cost * 100) if total_cost > 0 else 0.0
    tot_pnl_str = fmt_eur(total_pnl)
    tot_pct_str = fmt_pct(total_pct)
    print(f"  {'TOTALE':<72} €{total_val:>11,.0f} "
          f"{color(total_pnl, f'{tot_pnl_str:>12}')} "
          f"{color(total_pct, f'{tot_pct_str:>8}')}")
    print()


def print_sector_breakdown(pnl_df: pd.DataFrame, label: str):
    print(f"  ALLOCATION PER SETTORE — {label}")
    print(f"  {'SETTORE':<28} {'VAL EUR':>12} {'P&L EUR':>12} {'P&L %':>8} {'PESO':>6}")
    print(f"  {'─'*70}")

    by_sector = (
        pnl_df.groupby("settore")
        .agg(
            valore=("valore_attuale_eur", "sum"),
            pnl=("pnl_eur", "sum"),
            costo=("costo_totale_eur", "sum"),
        )
        .assign(pnl_pct=lambda x: x["pnl"] / x["costo"] * 100)
        .sort_values("valore", ascending=False)
    )
    total_val = by_sector["valore"].sum()
    by_sector["peso"] = by_sector["valore"] / total_val * 100

    for settore, row in by_sector.iterrows():
        pnl_str     = fmt_eur(row["pnl"])
        pnl_pct_str = fmt_pct(row["pnl_pct"])
        print(
            f"  {str(settore)[:28]:<28} "
            f"€{row['valore']:>11,.0f} "
            f"{color(row['pnl'], f'{pnl_str:>12}')} "
            f"{color(row['pnl_pct'], f'{pnl_pct_str:>8}')} "
            f"{row['peso']:>5.1f}%"
        )
    print()


def print_twr_table(twr_df: pd.DataFrame, summary: dict, label: str):
    print(f"  TIME-WEIGHTED RETURN (TWR) — {label}")
    print(f"  {'TICKER':<12} {'1M':>8} {'3M':>8} {'6M':>8} {'YTD':>8} {'1Y':>8}   {'P&L EUR':>12} {'P&L %':>8}")
    print(f"  {'─'*80}")

    for _, row in twr_df.sort_values("valore_eur", ascending=False).iterrows():
        def tw(k):
            v = row.get(k)
            if v is None or pd.isna(v):
                return "     N/D"
            return color(v, f"{fmt_pct(v):>8}")

        pnl_abs = row.get("pnl_abs_eur") or 0
        pnl_pct = row.get("pnl_pct") or 0
        err = row.get("error")
        if err:
            print(f"  {row['ticker']:<12} {'[errore: ' + str(err)[:50] + ']'}")
            continue

        pnl_abs_str = fmt_eur(pnl_abs)
        pnl_pct_str2 = fmt_pct(pnl_pct)
        print(
            f"  {row['ticker']:<12} "
            f"{tw('twr_1m')} {tw('twr_3m')} {tw('twr_6m')} {tw('twr_ytd')} {tw('twr_1y')}   "
            f"{color(pnl_abs, f'{pnl_abs_str:>12}')} "
            f"{color(pnl_pct, f'{pnl_pct_str2:>8}')}"
        )

    print(f"  {'─'*80}")
    print(f"  {'PORTFOLIO (wmean)':<12}", end="")
    for period in ["twr_1m", "twr_3m", "twr_6m", "twr_ytd", "twr_1y"]:
        v = summary.get(period)
        s = "     N/D" if v is None or pd.isna(v) else color(v, f"{fmt_pct(v):>8}")
        print(f" {s}", end="")
    print()


def export_to_excel(results: dict, output_path: str):
    """Esporta tutti i risultati in un Excel con tab separate."""
    with pd.ExcelWriter(output_path, engine="openpyxl") as writer:
        for label, data in results.items():
            pnl_df = data["pnl"]

            # Sheet P&L
            export_cols = [
                "ticker", "nome", "settore", "valuta",
                "quantita", "prezzo_carico", "prezzo_attuale", "fx_rate",
                "costo_totale_eur", "valore_attuale_eur",
                "pnl_eur", "pnl_pct", "peso_pct",
            ]
            pnl_df[export_cols].to_excel(
                writer, sheet_name=f"PnL_{label[:20]}", index=False
            )

            # Sheet TWR (se disponibile)
            twr_df = data.get("twr")
            if twr_df is not None:
                twr_cols = ["ticker", "twr_1m", "twr_3m", "twr_6m", "twr_ytd", "twr_1y",
                            "pnl_abs_eur", "pnl_pct", "peso_pct"]
                available = [c for c in twr_cols if c in twr_df.columns]
                twr_df[available].to_excel(
                    writer, sheet_name=f"TWR_{label[:20]}", index=False
                )

            # Sheet Settori
            sector_df = (
                pnl_df.groupby("settore")
                .agg(valore=("valore_attuale_eur","sum"),
                     pnl=("pnl_eur","sum"),
                     costo=("costo_totale_eur","sum"))
                .assign(pnl_pct=lambda x: x["pnl"]/x["costo"]*100,
                        peso=lambda x: x["valore"]/x["valore"].sum()*100)
                .sort_values("valore", ascending=False)
                .reset_index()
            )
            sector_df.to_excel(
                writer, sheet_name=f"Settori_{label[:15]}", index=False
            )

    print(f"\n  Output salvato in: {output_path}")


# ─── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="P&L Engine + TWR — Investment Portfolio Tracker")
    parser.add_argument("--file",       default=DEFAULT_FILE, help="Path al file Excel")
    parser.add_argument("--portfolio",  default="all",
                        choices=["all", "edo", "edoardo", "fede", "federico"],
                        help="Portfolio da analizzare")
    parser.add_argument("--live",       action="store_true",
                        help="Aggiorna prezzi live da yfinance")
    parser.add_argument("--twr",        action="store_true",
                        help="Calcola TWR (richiede connessione internet)")
    parser.add_argument("--export",     default=None,
                        help="Esporta risultati in Excel (es. --export output.xlsx)")
    parser.add_argument("--no-color",   action="store_true",
                        help="Disabilita colori ANSI")
    args = parser.parse_args()

    if args.no_color:
        global color
        color = lambda v, text: text  # noqa

    file_path = args.file
    if not Path(file_path).exists():
        print(f"[errore] File non trovato: {file_path}")
        print("  Usa --file <path> per specificare il percorso corretto.")
        sys.exit(1)

    # Seleziona fogli
    portfolio_filter = args.portfolio.lower()
    sheets_to_run = {}
    for sheet_name, display_label in PORTFOLIO_SHEETS.items():
        if portfolio_filter == "all":
            sheets_to_run[sheet_name] = display_label
        elif portfolio_filter in display_label.lower():
            sheets_to_run[sheet_name] = display_label

    if not sheets_to_run:
        print(f"[errore] Nessun portfolio trovato per: {args.portfolio}")
        sys.exit(1)

    all_results = {}

    for sheet_name, label in sheets_to_run.items():
        print(f"\n  Lettura foglio: {sheet_name}...")
        try:
            df = load_portfolio(file_path, sheet_name)
        except Exception as e:
            print(f"  [errore] {e}")
            continue

        if df.empty:
            print(f"  [warn] Nessuna posizione trovata in {sheet_name}")
            continue

        print(f"  {len(df)} posizioni trovate.")

        # P&L
        pnl_df = compute_pnl(df, label, use_live=args.live)
        print_pnl_table(pnl_df, label)
        print_sector_breakdown(pnl_df, label)

        result_entry = {"pnl": pnl_df}

        # TWR
        if args.twr:
            twr_df = compute_portfolio_twr(pnl_df, label)
            summary = portfolio_twr_summary(twr_df)
            print_twr_table(twr_df, summary, label)
            result_entry["twr"] = twr_df
            result_entry["twr_summary"] = summary

        all_results[label] = result_entry

    # Confronto Edoardo vs Federico (se entrambi disponibili)
    if len(all_results) == 2:
        labels = list(all_results.keys())
        print(f"\n  CONFRONTO {labels[0].upper()} vs {labels[1].upper()}")
        print(f"  {'':28} {'':>12} {'':>12}")
        for label, data in all_results.items():
            pnl_df = data["pnl"]
            tot_val  = pnl_df["valore_attuale_eur"].sum()
            tot_pnl  = pnl_df["pnl_eur"].sum()
            tot_cost = pnl_df["costo_totale_eur"].sum()
            tot_pct  = (tot_pnl / tot_cost * 100) if tot_cost > 0 else 0.0
            n_pos    = len(pnl_df)
            print(
                f"  {label:<20} "
                f"Val: €{tot_val:>10,.0f}   "
                f"P&L: {color(tot_pnl, fmt_eur(tot_pnl)):>12}  "
                f"({color(tot_pct, fmt_pct(tot_pct))})   "
                f"{n_pos} posizioni"
            )
        print()

    # Export
    if args.export:
        export_to_excel(all_results, args.export)

    print("  Done.\n")


if __name__ == "__main__":
    main()