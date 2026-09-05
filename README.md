# Trading Terminal — scheduled watchlist data

This repo runs your terminal as a static site, plus a scheduled GitHub Action
that fetches live data 4x/day (4:00am, 5:30am, 10:30am, 2:00pm Pacific) and
writes it to `data/candidates.json`, which the site reads on load.

## What's automated now — no API keys needed at all

All three of these are genuinely free, public, no-login, no-key sources:

1. **WSJ Markets headlines** — Dow Jones' own public RSS feed
   (`feeds.content.dowjones.io/public/rss/RSSMarketsMain`).
2. **Pre-market movers (highest raw volume, gap%)** — scraped from
   `stockanalysis.com/markets/premarket/gainers/` and `.../losers/`, which are
   plain public pages showing real dedicated pre-market data (not regular-
   session numbers relabeled). Filtered to your $5+ price rule.
3. **"Buzz among traders"** — StockTwits' public trending API
   (`api.stocktwits.com/api/2/streams/trending.json`). This is a genuine
   substitute for X: X removed its free read/search API entirely in 2026
   (confirmed directly), while StockTwits — a dedicated trader social
   platform, arguably a better fit for "buzz among traders" than X anyway —
   has no such restriction. Filtered to stocks only (crypto excluded) and
   your $5+ rule.

**Still not automatable, confirmed by directly testing each one:**
- **Briefing.com Story Stocks / ScanX** — fetching the page directly returns
  an empty JavaScript app shell with no content until an authenticated
  session loads the story data client-side. Briefing.com's own site lists
  Story Stocks under its paid "Platinum" tier.
- **Bloomberg.com article content** — the homepage loads, but has no
  structured ticker data and articles paywall almost immediately.

There's no manual-entry fallback needed anymore for items 1–3 in your
original list — they're fully automated now. Briefing.com content remains
genuinely outside what's possible for free.

## One-time setup

1. **Create a new GitHub repo** (public or private — both fine; this setup
   uses only a few Action-minutes per run, well under free-tier limits even
   for a private repo).
2. Push everything in this folder to that repo, preserving the structure:
   ```
   index.html
   data/candidates.json
   scripts/fetch-data.mjs
   .github/workflows/refresh-watchlist.yml
   ```
3. **Enable GitHub Pages**: repo -> Settings -> Pages -> Source: "Deploy from
   a branch" -> Branch: `main` -> `/ (root)`. Site goes live at
   `https://<your-username>.github.io/<repo-name>/`.
4. **No API keys to configure.** Nothing to sign up for.
5. **Test immediately** instead of waiting for the next scheduled time:
   repo -> Actions tab -> "Refresh Watchlist Data" -> "Run workflow" -> Run.
   Takes under a minute; refresh your site after.

## How the schedule works

GitHub's cron scheduler only understands UTC and doesn't shift for daylight
saving. Since your 4 target times are Pacific, the workflow is scheduled
**twice** for each — once for PST (UTC-8), once for PDT (UTC-7). The script
checks the real Pacific clock each run and only does the actual fetch within
~12 minutes of a real target slot; the "wrong" one of each pair exits in a
couple seconds and does nothing.

To change the 4 target times later, update **both** the `cron:` lines in
`.github/workflows/refresh-watchlist.yml` and the `TARGET_SLOTS` array in
`scripts/fetch-data.mjs` together.

## Known limitations (being upfront)

- **stockanalysis.com's page structure could change** without notice since
  we're parsing their public HTML table rather than a documented API — if
  the Action starts returning 0 screener candidates, that's the first thing
  to check (open the page in a browser and see if the table layout changed).
- **WSJ ticker-tagging** is a small hand-maintained keyword list
  (`COMPANY_TICKER_MAP` in `scripts/fetch-data.mjs`), not real NLP entity
  extraction. Add more company-to-ticker pairs any time.
- **StockTwits trending is a snapshot of one API call**, not a sustained
  mention-volume analysis — it reflects whichever stocks happen to be
  actively discussed in the most recent messages at the moment the Action
  runs, which has some randomness run-to-run.
