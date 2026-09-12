// Runs on a GitHub Actions schedule (see .github/workflows/refresh-watchlist.yml).
// Node 20+ has a built-in `fetch`, so this has zero npm dependencies on purpose —
// keeps the Action fast and avoids an npm install step entirely.

import { writeFile, readFile, mkdir } from "fs/promises";
import path from "path";

const TARGET_SLOTS = [
  { label: "4:00am PT", minutes: 4 * 60 },
  { label: "5:30am PT", minutes: 5 * 60 + 30 },
  { label: "10:30am PT", minutes: 10 * 60 + 30 },
  { label: "2:00pm PT", minutes: 14 * 60 }
];
const TOLERANCE_MIN = 12; // GitHub's scheduler can run a few minutes late

// ---- 1. Figure out whether "now" is actually one of our 4 target times ----
function getPacificNowMinutes() {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const parts = fmt.formatToParts(new Date());
  const h = parseInt(parts.find(p => p.type === "hour").value, 10);
  const m = parseInt(parts.find(p => p.type === "minute").value, 10);
  return h * 60 + m;
}

function matchedSlot() {
  const nowMin = getPacificNowMinutes();
  for (const slot of TARGET_SLOTS) {
    if (Math.abs(nowMin - slot.minutes) <= TOLERANCE_MIN) return slot;
  }
  return null;
}

// ---- 2. WSJ Markets RSS (public feed, no auth) ----
async function fetchWsjHeadlines() {
  const url = "https://feeds.content.dowjones.io/public/rss/RSSMarketsMain";
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" } });
  if (!res.ok) throw new Error("WSJ RSS fetch failed: " + res.status);
  const xml = await res.text();

  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRegex.exec(xml)) && items.length < 40) {
    const block = m[1];
    const grab = (tag) => {
      const r = new RegExp("<" + tag + ">([\\s\\S]*?)<\\/" + tag + ">");
      const mm = r.exec(block);
      if (!mm) return "";
      return mm[1]
        .replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "")
        .replace(/&#x2019;/g, "\u2019").replace(/&#x2018;/g, "\u2018")
        .replace(/&amp;/g, "&").replace(/&#xe9;/g, "\u00e9")
        .trim();
    };
    items.push({
      title: grab("title"),
      description: grab("description"),
      link: grab("link"),
      pubDate: grab("pubDate")
    });
  }
  return items;
}

// Small, expandable company-name → ticker lookup so headlines can be tagged.
// Add more pairs any time — this is intentionally simple (substring match),
// not a full NLP entity extractor.
const COMPANY_TICKER_MAP = {
  "Nvidia": "NVDA", "Boeing": "BA", "Shein": "SHEIN", "Volkswagen": "VWAGY",
  "Moderna": "MRNA", "Merck": "MRK", "Tempus AI": "TEM", "Personalis": "PSNL",
  "Amazon": "AMZN", "Hugging Face": "NVDA", "TD Bank": "TD", "Affirm": "AFRM",
  "Aon": "AON", "USI": "USI", "Rio Tinto": "RIO", "BHP": "BHP",
  "Silicon Valley Bank": "SIVBQ", "SVB Financial": "SIVBQ", "Oura": "OURA",
  "SpaceX": "SPCX", "Jersey Mike": "N/A", "Two Sigma": "N/A"
};

function tagTickers(text) {
  const found = [];
  for (const [name, ticker] of Object.entries(COMPANY_TICKER_MAP)) {
    if (text.includes(name)) found.push(ticker);
  }
  return [...new Set(found)];
}

// ---- 3. Pre-market movers (stockanalysis.com public pages — real pre-market
// data, no login, no API key). We fetch the plain HTML and parse the table;
// this is a normal public webpage, not an authenticated/paywalled endpoint. ----
// ---- 3. Pre-market/session movers via Financial Modeling Prep (FMP) — a
// real, properly-licensed developer API with a free tier (unlike the
// stockanalysis.com scraping this replaces: their own help page explicitly
// states "no API access... data license covers display, not programmatic
// access" — confirmed directly, not assumed). Needs a free FMP_API_KEY
// secret; degrades gracefully with a clear note if it's not set. ----
async function fetchFmpList(endpoint, key) {
  const url = `https://financialmodelingprep.com/stable/${endpoint}?apikey=${key}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FMP ${endpoint} failed: ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}
// CONFIRMED (from an actual run's log, HTTP 402 = Payment Required) that both
// /stable/quote (batch quotes) and /stable/company-screener require a paid
// FMP plan — despite what several third-party articles suggested. They are
// NOT usable here. The only two endpoints that have actually returned real
// data on the free tier are the gainers/losers/actives lists and
// /stable/profile (per-ticker only, no batching, but it does work and
// conveniently returns price, volume, averageVolume, sector, and industry
// all in one call).
async function fetchFmpProfile(ticker, key, dumpRaw) {
  try {
    const res = await fetch(`https://financialmodelingprep.com/stable/profile?symbol=${ticker}&apikey=${key}`);
    if (!res.ok) return null;
    const data = await res.json();
    const p = Array.isArray(data) ? data[0] : null;
    if (!p) return null;
    if (dumpRaw) {
      // One-time full dump so we know definitively which price/change fields
      // this stable-tier profile response actually has, instead of guessing —
      // /stable/quote (which we know has changesPercentage) is paid-only, so
      // it's unconfirmed whether profile carries an equivalent field.
      console.log(`[diag] Full raw profile response for ${ticker}: ${JSON.stringify(p)}`);
    }
    // Try every plausible field name for price and day change, in order of
    // likelihood, and compute % change ourselves if we only get a dollar
    // amount. Falls back to null (not a fake 0) if nothing usable is found.
    const price = p.price != null ? Number(p.price) : null;
    let changePct = null;
    if (p.changesPercentage != null) changePct = Number(p.changesPercentage);
    else if (p.changePercentage != null) changePct = Number(p.changePercentage);
    else if (p.changes != null && price != null) {
      const priorClose = price - Number(p.changes);
      if (priorClose) changePct = (Number(p.changes) / priorClose) * 100;
    }
    return {
      price,
      changePct,
      volume: p.volume != null ? Number(p.volume) : null,
      avgVolume: p.averageVolume != null ? Number(p.averageVolume) : null,
      sector: p.sector || null,
      industry: p.industry || null
    };
  } catch (e) {
    return null;
  }
}

// Mega-cap tickers that should always be tracked with real data, regardless
// of whether they crack the gainers/losers/actives % lists — those lists
// skew toward small/volatile names, so a mega cap having a genuinely big day
// (e.g. Oracle +5%) can otherwise never surface. Edit this list any time;
// it's a flat array on purpose so it's easy to add/remove tickers.
const ALWAYS_TRACK_TICKERS = [
  "AAPL", "MSFT", "NVDA", "GOOGL", "GOOG", "AMZN", "META", "TSLA", "ORCL", "AVGO",
  "JPM", "V", "MA", "UNH", "XOM", "WMT", "JNJ", "PG", "HD", "COST",
  "NFLX", "AMD", "CRM", "ADBE", "BA"
];

// ---- QQQ 10dma/20dma signal — per an independent backtest study (thousands
// of real breakout trades across two datasets), this plain two-moving-average
// rule was the ONLY signal that held up on genuinely out-of-sample data,
// beating every McClellan/breadth-style indicator tested. Costs one API call.
async function fetchQqqMaSignal(key) {
  const url = `https://financialmodelingprep.com/stable/historical-price-eod/light?symbol=QQQ&apikey=${key}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`QQQ history fetch failed: ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length < 20) throw new Error("Not enough QQQ history returned");
  // Rows are typically newest-first; normalize to be sure, then take the
  // most recent 20 closes.
  const sorted = [...rows].sort((a, b) => new Date(b.date) - new Date(a.date));
  const closes = sorted.slice(0, 20).map(r => Number(r.close != null ? r.close : r.price));
  if (closes.some(c => isNaN(c))) throw new Error("Unexpected price field in QQQ history response");
  const sma = (n) => closes.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const sma10 = sma(10);
  const sma20 = sma(20);
  return {
    date: sorted[0].date,
    price: closes[0],
    sma10: Number(sma10.toFixed(2)),
    sma20: Number(sma20.toFixed(2)),
    bullish: sma10 > sma20,
    spreadPct: Number((((sma10 - sma20) / sma20) * 100).toFixed(2))
  };
}

async function fetchScreener() {
  const key = process.env.FMP_API_KEY;
  if (!key) {
    return {
      available: false,
      note: "FMP_API_KEY secret not set — add a free key from financialmodelingprep.com as a repo secret to enable this.",
      candidates: []
    };
  }

  const note = [];
  let gainers = [], losers = [], actives = [];
  try { gainers = await fetchFmpList("biggest-gainers", key); } catch (e) { note.push("gainers: " + e.message); }
  try { losers = await fetchFmpList("biggest-losers", key); } catch (e) { note.push("losers: " + e.message); }
  try { actives = await fetchFmpList("most-actives", key); } catch (e) { note.push("actives: " + e.message); }

  const byTicker = {};
  [...gainers, ...losers, ...actives].forEach(r => {
    const price = Number(r.price) || 0;
    if (price <= 5) return; // user's own filter: priced above $5
    const ticker = r.symbol;
    if (!ticker || byTicker[ticker]) return;
    byTicker[ticker] = {
      ticker,
      name: r.name || ticker,
      price,
      changePct: Number(r.changesPercentage) || 0,
      _fromList: true
    };
  });

  // Add always-track mega-caps that aren't already in the pool — placeholder
  // entries here, real price/change/volume comes from the profile fetch below.
  ALWAYS_TRACK_TICKERS.forEach(ticker => {
    if (!byTicker[ticker]) {
      byTicker[ticker] = { ticker, name: ticker, price: null, changePct: null, _fromList: false, _megaCap: true };
    } else {
      byTicker[ticker]._megaCap = true;
    }
  });

  const tickers = Object.keys(byTicker);

  // Rank by |% change| first (mega-caps without a % yet sort last in this
  // step, doesn't matter — they get profile-fetched unconditionally below
  // regardless of rank), then only fetch the expensive per-ticker profile
  // data for a capped subset, to stay within FMP's 250-requests/day cap.
  const rankedTickers = [...tickers].sort((a, b) => Math.abs(byTicker[b].changePct || 0) - Math.abs(byTicker[a].changePct || 0));
  const TOP_MOVER_LIMIT = 15;
  const topMoverTargets = rankedTickers.filter(t => !byTicker[t]._megaCap).slice(0, TOP_MOVER_LIMIT);
  const megaCapTargets = tickers.filter(t => byTicker[t]._megaCap);
  const profileTargets = [...new Set([...topMoverTargets, ...megaCapTargets])];

  const profiles = {};
  let profileFound = 0;
  let dumpedOne = false;
  for (const ticker of profileTargets) {
    const p = await fetchFmpProfile(ticker, key, !dumpedOne);
    dumpedOne = true;
    if (p) { profiles[ticker] = p; profileFound++; }
    await new Promise(r => setTimeout(r, 120)); // be a reasonable citizen toward the API
  }
  console.log(`[diag] Profile data found for ${profileFound} of ${profileTargets.length} tickers checked (${topMoverTargets.length} top movers + ${megaCapTargets.length} always-track mega-caps)`);

  const candidates = tickers.map(ticker => {
    const base = byTicker[ticker];
    const p = profiles[ticker] || {};
    // Mega-caps with no list data start with null price/change — fill from
    // profile if we got it. List-sourced tickers keep their list price/change
    // unless profile gave us something (profile is usually fresher).
    const price = p.price != null ? p.price : base.price;
    const changePct = p.changePct != null ? p.changePct : base.changePct;
    const volume = p.volume || 0;
    const avgVolume = p.avgVolume || null;
    const rvol = avgVolume ? volume / avgVolume : null;
    return {
      ticker: base.ticker,
      name: base.name,
      price: price || 0,
      changePct: changePct || 0,
      volume,
      avgVolume,
      rvol, // e.g. 2.5 means trading at 2.5x its average volume
      sector: p.sector || null,
      industry: p.industry || null,
      hasProfileData: !!profiles[ticker],
      megaCap: !!base._megaCap,
      source: "Financial Modeling Prep (free tier, licensed API)",
      sourceUrl: `https://financialmodelingprep.com/quote/${ticker}`
    };
  }).filter(c => c.price > 5) // re-apply price filter now that mega-caps have real prices from profile
    .sort((a, b) => b.volume - a.volume);

  return {
    available: candidates.length > 0,
    note: note.join("; ") || (candidates.length ? "" : "No candidates returned — check FMP_API_KEY is valid and has remaining free-tier quota."),
    source: "Financial Modeling Prep (licensed free-tier API)",
    candidates
  };
}

// ---- 4. "Buzz among traders" — StockTwits public trending API is a real,
// free, no-auth substitute for X (X has no free read API as of 2026). ----
async function fetchStockTwitsBuzz() {
  const url = "https://api.stocktwits.com/api/2/streams/trending.json";
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" } });
  if (!res.ok) throw new Error("StockTwits fetch failed: " + res.status);
  const data = await res.json();

  const mentionCount = {}; // ticker -> { count, name, lastPrice, url }
  (data.messages || []).forEach(msg => {
    (msg.symbols || []).forEach(s => {
      if (s.instrument_class === "CRYPTO" || (s.symbol || "").endsWith(".X")) return; // stocks only
      const ticker = s.symbol;
      if (!mentionCount[ticker]) {
        mentionCount[ticker] = { ticker, name: s.title || ticker, count: 0, price: null, trendingScore: s.trending_score || 0 };
      }
      mentionCount[ticker].count++;
    });
    (msg.prices || []).forEach(p => {
      if (mentionCount[p.symbol]) mentionCount[p.symbol].price = parseFloat(p.price) || null;
    });
  });

  const buzzList = Object.values(mentionCount)
    .filter(t => t.price != null && t.price > 5) // user's own filter: priced above $5
    .sort((a, b) => (b.count + b.trendingScore) - (a.count + a.trendingScore))
    .slice(0, 5)
    .map(t => ({
      ticker: t.ticker,
      name: t.name,
      price: t.price,
      changePct: 0,
      volume: 0,
      source: "StockTwits trending (public feed — real substitute for X, which has no free read API)",
      sourceUrl: "https://stocktwits.com/symbol/" + t.ticker
    }));

  return buzzList;
}

// ---- Real per-ticker catalyst headline (server-side, so no CORS issue and
// no waiting on the client) — reuses the same free news API the News page
// uses. Runs once per candidate ticker after the screener/buzz lists are
// built, so the catalyst text is already real by the time the site loads it.
async function fetchCatalystForTicker(ticker) {
  try {
    const url = `https://freenewsapi.ai/v1/search?q=${encodeURIComponent(ticker)}&size=1&lang=en`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" } });
    if (!res.ok) return null;
    const data = await res.json();
    const top = data.results && data.results[0];
    if (!top || !top.title) return null;
    return { title: top.title, url: top.url || null };
  } catch (e) {
    return null;
  }
}
async function attachCatalysts(candidates, label) {
  for (const c of candidates) {
    const hit = await fetchCatalystForTicker(c.ticker);
    c.catalystHeadline = hit ? hit.title : null;
    c.catalystUrl = hit ? hit.url : null;
    // Be a reasonable citizen toward the free API — small stagger between calls.
    await new Promise(r => setTimeout(r, 150));
  }
  console.log(`[diag] Attached catalysts for ${candidates.length} ${label} candidates (${candidates.filter(c => c.catalystHeadline).length} found real headlines)`);
}

async function main() {
  // A manual "Run workflow" click (workflow_dispatch) should always do real
  // work, regardless of the time of day — otherwise there's no way to test.
  const isManualRun = process.env.GITHUB_EVENT_NAME === "workflow_dispatch";
  const slot = matchedSlot();
  const dataPath = path.join(process.cwd(), "data", "candidates.json");

  if (!slot && !isManualRun) {
    console.log("Not within a target Pacific time slot right now — skipping (no-op run).");
    return;
  }
  console.log(isManualRun && !slot
    ? "Manual run (workflow_dispatch) — running full refresh regardless of time."
    : "Matched slot: " + slot.label + " — running full refresh.");

  await mkdir(path.dirname(dataPath), { recursive: true });

  let wsjHeadlines = [];
  try {
    const raw = await fetchWsjHeadlines();
    wsjHeadlines = raw.map(item => ({
      ...item,
      tickers: tagTickers(item.title + " " + item.description)
    }));
  } catch (e) {
    console.error("WSJ fetch failed:", e.message);
  }

  let screener = { available: false, note: "Fetch failed", candidates: [] };
  try {
    screener = await fetchScreener();
  } catch (e) {
    console.error("Screener fetch failed:", e.message);
  }

  // No extra API calls needed — /stable/company-screener turned out to
  // require a paid FMP plan (confirmed via a real 402 response), so instead
  // of a dedicated query, the ≥9M-volume list is just the subset of the
  // screener candidates above that got real profile data (volume/avgVolume)
  // AND actually cleared 9M shares. Smaller pool than a true market-wide
  // scan would give, but it's real data instead of an endpoint we can't use.
  const volumeMovers = {
    available: false,
    note: "",
    movers: screener.candidates.filter(c => c.hasProfileData && c.volume >= 9000000)
  };
  volumeMovers.available = volumeMovers.movers.length > 0;
  if (!volumeMovers.available) {
    volumeMovers.note = "None of the top movers checked this run cleared 9M shares — this is limited to gainers/losers/actives constituents that got profile data, not a full market scan (FMP's dedicated volume screener requires a paid plan).";
  }
  console.log(`[diag] Volume >=9M movers (derived from already-fetched profile data, no extra calls): ${volumeMovers.movers.length}`);

  let buzz = [];
  try {
    buzz = await fetchStockTwitsBuzz();
  } catch (e) {
    console.error("StockTwits buzz fetch failed:", e.message);
  }

  // Attach a real per-ticker headline to each candidate so the app doesn't
  // have to show a generic placeholder in the catalyst column.
  try {
    if (screener.candidates && screener.candidates.length) await attachCatalysts(screener.candidates, "screener");
    if (volumeMovers.movers && volumeMovers.movers.length) await attachCatalysts(volumeMovers.movers, "volume-screener");
    if (buzz.length) await attachCatalysts(buzz, "buzz");
  } catch (e) {
    console.error("Catalyst attachment failed:", e.message);
  }

  // QQQ 10dma/20dma market-timing gate — see fetchQqqMaSignal for why this
  // one indicator, and not McClellan/breadth-style ones, made the cut.
  let qqqSignal = { available: false, note: "" };
  const fmpKey = process.env.FMP_API_KEY;
  if (fmpKey) {
    try {
      qqqSignal = await fetchQqqMaSignal(fmpKey);
      qqqSignal.available = true;
      console.log(`[diag] QQQ 10dma/20dma: ${qqqSignal.sma10} vs ${qqqSignal.sma20} (${qqqSignal.bullish ? "bullish" : "bearish"}, spread ${qqqSignal.spreadPct}%)`);
    } catch (e) {
      qqqSignal = { available: false, note: e.message };
      console.error("QQQ MA signal fetch failed:", e.message);
    }
  } else {
    qqqSignal.note = "FMP_API_KEY not set";
  }

  // Real (not fake/demo) daily count of big movers, built from data already
  // fetched above — zero extra API calls. Appends to a running history file
  // so the chart genuinely grows day over day instead of being backfilled
  // with invented numbers. This is the "leadership" measure the backtest
  // found actually carried signal — though note it's a same-day gap% count
  // from our own screener universe, not the stricter "up 50% over a month"
  // measure from that study; a true rolling-return leadership count would
  // need historical price per ticker, which isn't in this session's budget.
  const historyPath = path.join(process.cwd(), "data", "breadth-history.json");
  let breadthHistory = [];
  try {
    const raw = await readFile(historyPath, "utf8");
    breadthHistory = JSON.parse(raw);
    if (!Array.isArray(breadthHistory)) breadthHistory = [];
  } catch (e) {
    breadthHistory = []; // first run ever, or file doesn't exist yet
  }
  const today = new Date().toISOString().slice(0, 10);
  const up20 = screener.candidates.filter(c => c.changePct >= 20).length;
  const down20 = screener.candidates.filter(c => c.changePct <= -20).length;
  const todayIdx = breadthHistory.findIndex(d => d.date === today);
  const todayEntry = { date: today, up20, down20 };
  if (todayIdx >= 0) breadthHistory[todayIdx] = todayEntry;
  else breadthHistory.push(todayEntry);
  breadthHistory.sort((a, b) => a.date.localeCompare(b.date));
  if (breadthHistory.length > 120) breadthHistory = breadthHistory.slice(-120);
  await writeFile(historyPath, JSON.stringify(breadthHistory, null, 2));
  console.log(`[diag] Breadth history: today ${up20} up20 / ${down20} down20 · ${breadthHistory.length} day(s) tracked total`);

  const output = {
    generatedAt: new Date().toISOString(),
    generatedSlot: slot ? slot.label : "Manual run",
    wsjHeadlines,
    screener,
    volumeMovers,
    buzz,
    qqqSignal,
    breadthHistory
  };

  await writeFile(dataPath, JSON.stringify(output, null, 2));
  console.log("Wrote " + dataPath);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
