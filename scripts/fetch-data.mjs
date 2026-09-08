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
async function fetchPremarketTable(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" } });
  if (!res.ok) throw new Error("stockanalysis.com fetch failed: " + res.status);
  const html = await res.text();

  // Generic, dependency-free HTML table row parser. Column order on these
  // pages is: No. | Symbol | Company Name | % Change | Premkt. Price | Pre. Volume | Market Cap
  const rows = [];
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let rm;
  let totalTrCount = 0;
  const cellCountsSeen = [];
  while ((rm = rowRegex.exec(html))) {
    totalTrCount++;
    const rowHtml = rm[1];
    const cells = [];
    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
    let cm;
    while ((cm = cellRegex.exec(rowHtml))) {
      const text = cm[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim();
      cells.push(text);
    }
    cellCountsSeen.push(cells.length);
    if (cells.length >= 7) rows.push(cells);
  }
  // Diagnostics: this tells us exactly what the parser is seeing on the real
  // page, since we can't inspect stockanalysis.com's live markup directly —
  // remove this block once the real row/cell shape is confirmed and stable.
  console.log(`[diag] ${url} -> found ${totalTrCount} <tr> total, ${rows.length} with >=7 <td> cells`);
  console.log(`[diag] cell counts per row (first 15): ${cellCountsSeen.slice(0, 15).join(", ")}`);
  if (rows.length) {
    console.log(`[diag] first parsed row: ${JSON.stringify(rows[0])}`);
  }
  if (totalTrCount > 0 && rows.length <= 1) {
    // Something is off after row 1 — dump a raw snippet around the 2nd <tr> to see real structure
    const secondTrIdx = html.indexOf("<tr", html.indexOf("<tr") + 3);
    if (secondTrIdx >= 0) {
      console.log(`[diag] raw HTML snippet from 2nd <tr>: ${html.slice(secondTrIdx, secondTrIdx + 500).replace(/\n/g, " ")}`);
    }
  }

  return rows.map(cells => {
    const [, symbol, name, changePctStr, price, volumeStr] = cells;
    return {
      ticker: (symbol || "").toUpperCase(),
      name: name || symbol,
      price: parseFloat(String(price).replace(/[$,]/g, "")) || 0,
      changePct: parseFloat(String(changePctStr).replace(/[%,]/g, "")) || 0,
      volume: parseInt(String(volumeStr).replace(/[,\-]/g, ""), 10) || 0
    };
  }).filter(r => r.ticker);
}

async function fetchScreener() {
  const note = [];
  let gainers = [], losers = [];
  try {
    gainers = await fetchPremarketTable("https://stockanalysis.com/markets/premarket/gainers/");
  } catch (e) { note.push("gainers fetch failed: " + e.message); }
  try {
    losers = await fetchPremarketTable("https://stockanalysis.com/markets/premarket/losers/");
  } catch (e) { note.push("losers fetch failed: " + e.message); }

  const all = [...gainers, ...losers]
    .filter(r => r.price > 5) // user's own filter: priced above $5
    .sort((a, b) => b.volume - a.volume);

  return {
    available: all.length > 0,
    note: note.join("; ") || (all.length ? "" : "No rows parsed — stockanalysis.com's page structure may have changed."),
    source: "stockanalysis.com/markets/premarket (public, no login)",
    candidates: all.map(r => ({
      ...r,
      source: "stockanalysis.com pre-market movers",
      sourceUrl: "https://stockanalysis.com/stocks/" + r.ticker.toLowerCase() + "/"
    }))
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
    if (buzz.length) await attachCatalysts(buzz, "buzz");
  } catch (e) {
    console.error("Catalyst attachment failed:", e.message);
  }

  const output = {
    generatedAt: new Date().toISOString(),
    generatedSlot: slot ? slot.label : "Manual run",
    wsjHeadlines,
    screener,
    buzz
  };

  await writeFile(dataPath, JSON.stringify(output, null, 2));
  console.log("Wrote " + dataPath);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
