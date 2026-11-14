# Investment Tracker

> **Work in progress.** Two halves that do the same job in two ways, not yet joined: a Python engine that works today
> on an Excel tracker, and a web app that will replace the spreadsheet.

Tracks a multi-broker portfolio (stocks, ETFs, bonds, crypto) in one currency: positions, unrealized and realized P&L,
sector allocation and time-weighted return.

## Status

| Part | What it does today | State |
|---|---|---|
| `engine/` | Reads the Excel tracker, prices every position (stored or live from Yahoo Finance), converts to EUR / USD / CHF / GBP / JPY, computes P&L per position and sector and a return table from price history, exports to Excel. Streamlit dashboard on top: metric cards, allocation and P&L charts, side-by-side comparison of two portfolios | Works locally |
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

Two things worth knowing:

- Without `--live` the engine uses the prices stored in the workbook. If a row's quantity times price does not match
  the sheet's own total (a value typed into the price cell, for instance), the engine derives the unit price from the
  total and prints a warning, so one bad cell cannot distort the whole portfolio.
- The return table is the price return of each current holding over 1, 3 and 6 months, year to date and 1 year,
  weighted by today's value. It is not a true time-weighted return yet: that needs the dated history of buys and
  sells, which the workbook does not hold.

## Run the app

```bash
cd app && cp .env.example .env
```

Fill `.env` with the Supabase project's URL and publishable key, copy `supabase/config.example.toml` to
`supabase/config.toml` with your project ref, then:

```bash
bun install
```

```bash
bun run dev
```

The lockfile is Bun's (`bun.lock`). Plain `npm install` stops on a peer-dependency conflict; without Bun installed,
`npx bun@1 install` does the same job and `npm run dev` then works.

The database schema is in `app/supabase/migrations/`. Each upload is a full snapshot of one platform and replaces the
previous one; the dashboard shows only the newest upload of each platform.

### How the statements are read

- **Select every statement of a platform at once.** Positions are rebuilt from the first transaction, so a statement
  read alone gets quantities and average costs wrong. The upload page takes several files and drops rows that appear
  in more than one. If more of a coin went out than the files show coming in, it says the history is incomplete.
- **Crypto.com.** An exchange is one row with two legs: the coin given up in `Currency` and the coin received in
  `To Currency`. Both are booked, at the value of the row. Staking lock-ups and other moves between your own wallets
  change nothing. Rows valued in USD are converted to EUR at the ECB rate of their own date.
- **Revolut.** European shares get their exchange suffix (`DHL` becomes `DHL.DE`), because the bare symbol can be a
  different company on the price feed. A redeemed bond closes the position like a sale.
- Average cost is the running weighted average in EUR. Coins sent to another wallet are booked out at their value on
  the day and shown under Transfers, apart from sales.

## Next

- [ ] One source of truth: the app's database replaces the spreadsheet, the engine reads from it
- [ ] A true time-weighted return from dated transactions, in both halves
- [ ] Port the sector view from the engine to the app
- [ ] Sample data set, so the project runs without a real portfolio
- [ ] More statement parsers (the Excel tracker itself, other brokers)
- [ ] Tests for the parsers and the P&L maths (today they are checked by hand against real statements)
- [ ] Transfers to an own wallet should carry their cost with them, not count as a gain or loss
- [ ] Sign-in and per-user data checked end to end before the app is hosted anywhere public
