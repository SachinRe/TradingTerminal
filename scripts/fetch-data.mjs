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
async function fetchFmpQuotesBatch(symbols, key) {
  if (!symbols.length) return {};
  // FMP supports comma-separated multi-symbol quotes in one call.
  const url = `https://financialmodelingprep.com/stable/quote?symbol=${symbols.join(",")}&apikey=${key}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FMP batch quote failed: ${res.status}`);
  const data = await res.json();
  const byTicker = {};
  (Array.isArray(data) ? data : []).forEach(q => { byTicker[q.symbol] = q; });
  return byTicker;
}
async function fetchFmpAverageVolume(ticker, key) {
  // Average volume is NOT on /stable/quote — confirmed via FMP's own docs
  // and changelog ("Volume + Average Volume Fields Added: Profile", Oct 2024).
  // It lives on /stable/profile instead, one ticker at a time.
  try {
    const res = await fetch(`https://financialmodelingprep.com/stable/profile?symbol=${ticker}&apikey=${key}`);
    if (!res.ok) return null;
    const data = await res.json();
    const p = Array.isArray(data) ? data[0] : null;
    const avg = p && p.averageVolume != null ? Number(p.averageVolume) : null;
    return avg && avg > 0 ? avg : null;
  } catch (e) {
    return null;
  }
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
      changePct: Number(r.changesPercentage) || 0
    };
  });

  const tickers = Object.keys(byTicker);
  let quotes = {};
  try {
    // Batch in chunks of 50 to stay well within reasonable URL/response size.
    for (let i = 0; i < tickers.length; i += 50) {
      const chunk = tickers.slice(i, i + 50);
      const batch = await fetchFmpQuotesBatch(chunk, key);
      quotes = { ...quotes, ...batch };
    }
  } catch (e) {
    note.push("quote batch: " + e.message);
  }

  // Average volume needs a separate per-ticker call (profile endpoint), and
  // FMP's free tier caps at 250 requests/day total across all 4 scheduled
  // runs — one call per ticker for ~68 tickers would burn most of that in a
  // single run. Only fetch it for the top 10 by raw volume, since that's
  // already the pool the Top-5-by-Volume/RVOL panels pick from anyway.
  const topByVolumeForAvg = tickers
    .map(t => ({ t, v: Number((quotes[t] || {}).volume) || 0 }))
    .sort((a, b) => b.v - a.v)
    .slice(0, 10)
    .map(x => x.t);
  const avgVolumes = {};
  let avgVolFound = 0;
  for (const ticker of topByVolumeForAvg) {
    const avg = await fetchFmpAverageVolume(ticker, key);
    if (avg != null) { avgVolumes[ticker] = avg; avgVolFound++; }
    await new Promise(r => setTimeout(r, 120)); // be a reasonable citizen toward the API
  }
  console.log(`[diag] Average volume found for ${avgVolFound} of ${topByVolumeForAvg.length} top-volume tickers (RVOL limited to top 10 to stay within FMP's 250/day free-tier cap)`);

  const candidates = tickers.map(ticker => {
    const base = byTicker[ticker];
    const q = quotes[ticker] || {};
    const volume = Number(q.volume) || 0;
    const avgVolume = avgVolumes[ticker] || null;
    const rvol = avgVolume ? volume / avgVolume : null;
    return {
      ...base,
      volume,
      avgVolume,
      rvol, // e.g. 2.5 means trading at 2.5x its average volume
      source: "Financial Modeling Prep (free tier, licensed API)",
      sourceUrl: `https://financialmodelingprep.com/quote/${ticker}`
    };
  }).sort((a, b) => b.volume - a.volume);

  return {
    available: candidates.length > 0,
    note: note.join("; ") || (candidates.length ? "" : "No candidates returned — check FMP_API_KEY is valid and has remaining free-tier quota."),
    source: "Financial Modeling Prep (licensed free-tier API)",
    candidates
  };
}

// ---- 3b. Dedicated ≥9M-volume screener — direct query, not derived from
// gainers/losers/actives. Those lists skew toward small/cheap high-%-move
// names that don't reliably cross a 9M raw-share-volume threshold, especially
// once combined with a $5+ price filter (cheap stocks trade more raw shares
// per dollar, so the price filter excludes exactly the names most likely to
// hit 9M shares). FMP's screener also returns real sector/industry directly —
// more reliable than our own hand-maintained ticker→sector map. ----
async function fetchVolumeMovers(key) {
  const url = `https://financialmodelingprep.com/stable/company-screener?volumeMoreThan=9000000&priceMoreThan=5&limit=100&apikey=${key}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FMP volume screener failed: ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) return { available: false, note: "No stocks returned at this volume/price threshold right now.", movers: [] };

  const symbols = rows.map(r => r.symbol).filter(Boolean);
  let quotes = {};
  for (let i = 0; i < symbols.length; i += 50) {
    const chunk = symbols.slice(i, i + 50);
    try {
      const batch = await fetchFmpQuotesBatch(chunk, key);
      quotes = { ...quotes, ...batch };
    } catch (e) { /* keep going with whatever we have */ }
  }

  const movers = rows.map(r => {
    const q = quotes[r.symbol] || {};
    return {
      ticker: r.symbol,
      name: r.companyName || r.symbol,
      price: Number(r.price) || Number(q.price) || 0,
      changePct: Number(q.changePercentage) || 0,
      volume: Number(r.volume) || Number(q.volume) || 0,
      sector: r.sector || null,
      industry: r.industry || null,
      source: "Financial Modeling Prep company-screener (licensed API)",
      sourceUrl: `https://financialmodelingprep.com/quote/${r.symbol}`
    };
  }).filter(m => m.volume >= 9000000); // re-confirm after merging in case quote volume differs from screener's cached volume

  return { available: movers.length > 0, note: "", movers };
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

  let volumeMovers = { available: false, note: "FMP_API_KEY not set", movers: [] };
  const fmpKey = process.env.FMP_API_KEY;
  if (fmpKey) {
    try {
      volumeMovers = await fetchVolumeMovers(fmpKey);
      console.log(`[diag] Dedicated volume screener: ${volumeMovers.movers.length} stocks at >=9M volume, priced above $5`);
    } catch (e) {
      console.error("Volume movers fetch failed:", e.message);
      volumeMovers = { available: false, note: e.message, movers: [] };
    }
  }

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

  const output = {
    generatedAt: new Date().toISOString(),
    generatedSlot: slot ? slot.label : "Manual run",
    wsjHeadlines,
    screener,
    volumeMovers,
    buzz
  };

  await writeFile(dataPath, JSON.stringify(output, null, 2));
  console.log("Wrote " + dataPath);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
