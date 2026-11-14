# Investment Tracker

> **Work in progress.** Two halves that do the same job in two ways, not yet joined: a Python engine that works today
> on an Excel tracker, and a web app that will replace the spreadsheet.

Tracks a multi-broker portfolio (stocks, ETFs, bonds, crypto) in one currency: positions, unrealized and realized P&L,
sector allocation and time-weighted return.

## Status

| Part | What it does today | State |
|---|---|---|
| `engine/` | Reads the Excel tracker, prices every position (stored or live from Yahoo Finance), converts to EUR / USD / CHF / GBP / JPY, computes P&L per position and sector, time-weighted return from price history, exports to Excel. Streamlit dashboard on top: metric cards, allocation and P&L charts, side-by-side comparison of two portfolios | Works locally |
| `app/` | Web app: upload a Revolut (`.xlsx`) or Crypto.com (`.csv`) statement, review the parsed positions, save them, see a live dashboard. Prices come from a Supabase edge function (CoinGecko for crypto, Yahoo Finance for securities, Frankfurter for FX). Realized P&L split by sales, dividends, coupons | Prototype |

**The app has no sign-in yet.** Its latest migration (`app/drizzle/migrations/0000_open_access_no_auth.sql`) opens
the tables to anyone holding the project's public key, as one shared data set. That is fine for a prototype with
sample data and wrong for real holdings on a hosted instance. Closing it is the last item under Next.

## Folders

| Folder | What is in it |
|---|---|
| `engine/` | `pnl_engine.py` (P&L, FX, TWR, CLI), `dashboard.py` (Streamlit), `requirements.txt` |
| `app/` | TanStack Start + React 19 + Tailwind 4 + shadcn/ui, Supabase (Postgres, edge function `get-prices`). Started on Lovable. Parsers in `src/lib/parsers.ts`, pages in `src/routes/` |
| `data/` | The tracker spreadsheet and broker statements. **Never in git**: only `.gitkeep` is tracked |

## Run the engine

```bash
pip install -r engine/requirements.txt
```

```bash
python engine/pnl_engine.py --live --twr
```

```bash
streamlit run engine/dashboard.py
```

Both read `data/INVESTMENT PORTFOLIO TRACKER (3).xlsx` unless `--file` says otherwise. The workbook needs one sheet per
portfolio with ticker, quantity, average cost, currency and sector. Sheet names are set in `PORTFOLIO_SHEETS` and
column names in `COL_MAP`, both at the top of `pnl_engine.py`.

## Run the app

```bash
cd app && cp .env.example .env
```

Fill `.env` with the Supabase project's URL and publishable key, copy `supabase/config.example.toml` to
`supabase/config.toml` with your project ref, then:

```bash
npm install && npm run dev
```

The database schema is in `app/supabase/migrations/`.

## Next

- [ ] One source of truth: the app's database replaces the spreadsheet, the engine reads from it
- [ ] Port time-weighted return and the sector view from the engine to the app
- [ ] Sample data set, so the project runs without a real portfolio
- [ ] More statement parsers (the Excel tracker itself, other brokers)
- [ ] Tests for the parsers and the P&L maths
- [ ] Sign-in and per-user data checked end to end before the app is hosted anywhere public
