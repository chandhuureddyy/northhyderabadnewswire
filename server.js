require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const axios = require("axios");
const cron = require("node-cron");
const nodemailer = require("nodemailer");
const Parser = require("rss-parser");

const AREAS = require("./areas");
const PRIORITY_DOMAINS = require("./priority-sources");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const parser = new Parser({
  headers: { "User-Agent": "Mozilla/5.0 (compatible; NorthHydNewsBot/1.0)" }
});

const DATA_DIR = path.join(__dirname, "data");
const SEEN_FILE = path.join(DATA_DIR, "seen.json");
const LATEST_FILE = path.join(DATA_DIR, "latest.json");
const EVENTS_FILE = path.join(DATA_DIR, "events.json");
const SUBSCRIBERS_FILE = path.join(DATA_DIR, "subscribers.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
for (const f of [SEEN_FILE, LATEST_FILE, EVENTS_FILE, SUBSCRIBERS_FILE]) {
  if (!fs.existsSync(f)) fs.writeFileSync(f, "[]");
}

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ---------- Fetchers (generic: take a raw query string) ----------

async function fetchGoogleNews(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(
    query
  )}&hl=en-IN&gl=IN&ceid=IN:en`;

  try {
    const feed = await parser.parseURL(url);
    return (feed.items || []).map((item) => ({
      title: item.title,
      link: item.link,
      source: (item.title && item.title.split(" - ").pop()) || "Google News",
      publishedAt: item.pubDate ? new Date(item.pubDate).toISOString() : null,
      provider: "google-news-rss"
    }));
  } catch (err) {
    console.error(`[google-news] "${query}" failed:`, err.message);
    return [];
  }
}

async function fetchBingNews(query) {
  const url = `https://www.bing.com/news/search?q=${encodeURIComponent(
    query
  )}&format=rss&setmkt=en-IN`;

  try {
    const feed = await parser.parseURL(url);
    return (feed.items || []).map((item) => ({
      title: item.title,
      link: item.link,
      source: item.source || item.creator || "Bing News",
      publishedAt: item.pubDate ? new Date(item.pubDate).toISOString() : null,
      provider: "bing-news-rss"
    }));
  } catch (err) {
    console.error(`[bing-news] "${query}" failed:`, err.message);
    return [];
  }
}

async function fetchNewsApi(query) {
  const key = process.env.NEWSAPI_KEY;
  if (!key) return [];

  try {
    const resp = await axios.get("https://newsapi.org/v2/everything", {
      params: { q: query, language: "en", sortBy: "publishedAt", pageSize: 15, apiKey: key },
      timeout: 10000
    });
    return (resp.data.articles || []).map((a) => ({
      title: a.title,
      link: a.url,
      source: a.source?.name || "NewsAPI",
      publishedAt: a.publishedAt,
      provider: "newsapi"
    }));
  } catch (err) {
    console.error(`[newsapi] "${query}" failed:`, err.message);
    return [];
  }
}

// Optional: Google Custom Search JSON API -- the closest match to "search
// like on Google": returns whatever's actually indexed (news, blogs,
// forums, official notices, PDFs), with a visible snippet, not just
// articles tagged as "News" by Google News. Free tier: 100 queries/day.
// Only runs if GOOGLE_CSE_KEY + GOOGLE_CSE_CX are set.
async function fetchGoogleCse(query, dateRestrictDays) {
  const key = process.env.GOOGLE_CSE_KEY;
  const cx = process.env.GOOGLE_CSE_CX;
  if (!key || !cx) return [];

  try {
    const resp = await axios.get("https://www.googleapis.com/customsearch/v1", {
      params: {
        key,
        cx,
        q: query,
        num: 10,
        dateRestrict: `d${dateRestrictDays}` // Google's own recency filter
      },
      timeout: 10000
    });
    return (resp.data.items || []).map((item) => ({
      title: item.title,
      link: item.link,
      source: item.displayLink || "Web",
      snippet: item.snippet || "",
      // Google CSE doesn't return a reliable publish date for most pages;
      // leave publishedAt null -- dateRestrict above is what actually
      // governs recency for this provider, not the window filter below.
      publishedAt: null,
      provider: "google-cse"
    }));
  } catch (err) {
    console.error(`[google-cse] "${query}" failed:`, err.response?.data?.error?.message || err.message);
    return [];
  }
}

// Filters out things that technically matched the search but aren't real,
// dated articles -- tag/category archive pages (e.g. a site's
// /tag/some-topic listing, whose page title is just the tag name) and
// generic feed titles (e.g. "Latest News - Telangana Today", which is the
// feed's own name, not a headline).
const JUNK_URL_PATTERN = /\/(tag|tags|topic|topics|category|categories|author|authors|section|epaper|e-paper)\//i;
const JUNK_TITLE_PATTERNS = [
  /^latest news\b/i,
  /^home\s*-/i,
  /^[a-z0-9]+(-[a-z0-9]+){1,}$/i // a bare url-slug used as the title, e.g. "sahiti-group"
];

// "X - X" (source name repeated as the title, e.g. wire-service
// placeholders like "United News of India - United News of India")
function isRepeatedSourceTitle(title) {
  const parts = title.split(" - ");
  if (parts.length !== 2) return false;
  return parts[0].trim().toLowerCase() === parts[1].trim().toLowerCase();
}

function isJunk(item) {
  let link = item.link || "";
  try {
    link = decodeURIComponent(link); // Bing wraps real URLs inside apiclick.aspx?...&url=<encoded>
  } catch {
    // leave as-is if decoding fails
  }
  if (link && (JUNK_URL_PATTERN.test(link) || /epaper\./i.test(link))) return true;
  const title = (item.title || "").trim();
  if (JUNK_TITLE_PATTERNS.some((p) => p.test(title))) return true;
  if (isRepeatedSourceTitle(title)) return true;
  return false;
}

function dedupe(items) {
  const seenKeys = new Set();
  const out = [];
  for (const item of items) {
    if (isJunk(item)) continue;
    const key = item.link || item.title;
    if (!key || seenKeys.has(key)) continue;
    seenKeys.add(key);
    out.push(item);
  }
  return out;
}

function withinDays(items, days) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return items.filter((item) => !item.publishedAt || new Date(item.publishedAt).getTime() >= cutoff);
}

// ---------- News pipeline ----------

async function fetchAllAreas() {
  const results = [];
  const windowDays = Number(process.env.NEWS_WINDOW_DAYS || 15);
  const priorityQuerySuffix = `(site:${PRIORITY_DOMAINS.join(" OR site:")})`;

  for (const area of AREAS) {
    const [general, bing, newsApi, cse, priorityGoogle, priorityBing] = await Promise.all([
      fetchGoogleNews(area.query),
      fetchBingNews(area.query),
      fetchNewsApi(area.query),
      fetchGoogleCse(area.query, windowDays),
      fetchGoogleNews(`${area.query} ${priorityQuerySuffix}`),
      fetchBingNews(`${area.query} ${priorityQuerySuffix}`)
    ]);

    const tagged = [...general, ...bing, ...newsApi, ...cse, ...priorityGoogle, ...priorityBing].map((i) => ({
      ...i,
      area: area.label,
      areaId: area.id
    }));
    results.push(...tagged);
    await new Promise((r) => setTimeout(r, 250)); // small stagger between areas
  }

  const deduped = dedupe(results);
  const inWindow = withinDays(deduped, windowDays);
  inWindow.sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
  return inWindow;
}

// ---------- Upcoming events pipeline ----------
// Not a structured government events calendar (no public API for that
// exists) -- this is keyword-matched against recent news/search text.
// Journalism habitually uses present tense for things that JUST happened
// ("X inaugurates new facility" = already done), so topic keywords alone
// (metro, launch, notice...) mostly surfaced past coverage, not upcoming
// items. This requires an actual future-tense phrase to match, and then
// drops anything that also reads as a completed action.

const EVENT_KEYWORDS =
  '("to be inaugurated" OR "will be inaugurated" OR "set to open" OR "slated to open" OR "will open" OR "to open soon" OR "coming soon" OR "scheduled to be held" OR "scheduled for" OR "to be held" OR "will be held" OR "upcoming event" OR "public notice" OR "tender notice" OR "GHMC notification" OR "HMDA notification")';

// If a result also contains clearly-completed-action language, it's
// describing something that already happened, regardless of which future
// phrase above got it matched (e.g. quoting past context in an otherwise
// unrelated article). Drop it.
const PAST_TENSE_EXCLUDE = [
  /\binaugurat(es|ed)\b/i,
  /\blaunch(es|ed)\b/i,
  /\bopen(s|ed)\b(?!\s+soon)/i,
  /\bunveil(s|ed)\b/i,
  /\bcommission(s|ed)\b/i,
  /\bwas held\b/i,
  /\bwere held\b/i,
  /\bcompletes?\b/i,
  /\bcompleted\b/i,
  /\bheld (on|at|in)\b/i
];

function isPastTense(title) {
  return PAST_TENSE_EXCLUDE.some((p) => p.test(title || ""));
}

async function fetchAllEvents() {
  const results = [];
  const freshDays = Number(process.env.EVENTS_LOOKBACK_DAYS || 7); // how recent the *announcement* must be
  const cseDays = Math.min(freshDays, 15); // CSE dateRestrict is capped sensibly here too

  for (const area of AREAS) {
    const query = `${area.query} ${EVENT_KEYWORDS}`;
    const [google, bing, cse] = await Promise.all([
      fetchGoogleNews(query),
      fetchBingNews(query),
      fetchGoogleCse(query, cseDays)
    ]);

    const tagged = [...google, ...bing, ...cse].map((i) => ({
      ...i,
      area: area.label,
      areaId: area.id
    }));
    results.push(...tagged);
    await new Promise((r) => setTimeout(r, 250));
  }

  const deduped = dedupe(results).filter((i) => !isPastTense(i.title));
  const fresh = withinDays(deduped, freshDays);
  fresh.sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
  return fresh;
}

// ---------- Email ----------

function getTransport() {
  if (process.env.EMAIL_ENABLED !== "true") return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: process.env.SMTP_SECURE !== "false",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

function buildDigestHtml(items) {
  const rows = items
    .map(
      (i) => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;">
          <a href="${i.link}" style="color:#1a56db;text-decoration:none;font-weight:600;">${i.title}</a><br/>
          <span style="color:#666;font-size:12px;">${i.source} · ${i.area} · ${
        i.publishedAt ? new Date(i.publishedAt).toLocaleString("en-IN") : ""
      }</span>
        </td>
      </tr>`
    )
    .join("");

  return `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;">
      <h2 style="color:#111;">North Hyderabad News Digest</h2>
      <p style="color:#555;">${items.length} new article(s) across Kompally, Suchitra, Medchal and nearby areas.</p>
      <table style="width:100%;border-collapse:collapse;">${rows}</table>
      <p style="color:#999;font-size:11px;margin-top:16px;">Sent automatically by your North Hyderabad News app.</p>
    </div>`;
}

async function sendDigest(newItems) {
  const transport = getTransport();
  if (!transport) return;

  const to =
    (readJSON(SUBSCRIBERS_FILE).length
      ? readJSON(SUBSCRIBERS_FILE).join(",")
      : "") || process.env.NOTIFY_TO;

  if (!to) {
    console.log("[email] No recipients configured, skipping send.");
    return;
  }

  try {
    await transport.sendMail({
      from: process.env.NOTIFY_FROM || process.env.SMTP_USER,
      to,
      subject: `North Hyderabad News: ${newItems.length} new update(s)`,
      html: buildDigestHtml(newItems)
    });
    console.log(`[email] Digest sent to ${to} (${newItems.length} items).`);
  } catch (err) {
    console.error("[email] Failed to send digest:", err.message);
  }
}

// ---------- Core refresh cycle ----------

let isRefreshing = false;
let isRefreshingEvents = false;

async function runRefresh() {
  if (isRefreshing) return readJSON(LATEST_FILE);
  isRefreshing = true;
  console.log(`[refresh] Fetching news @ ${new Date().toISOString()}`);

  try {
    const all = await fetchAllAreas();
    const seen = new Set(readJSON(SEEN_FILE));
    const newItems = all.filter((i) => i.link && !seen.has(i.link));

    writeJSON(LATEST_FILE, all.slice(0, 300));

    if (newItems.length) {
      newItems.forEach((i) => seen.add(i.link));
      // keep the seen-set from growing forever
      const trimmed = Array.from(seen).slice(-3000);
      writeJSON(SEEN_FILE, trimmed);
      await sendDigest(newItems);
    }

    console.log(`[refresh] Done. ${all.length} total, ${newItems.length} new.`);
    return all;
  } finally {
    isRefreshing = false;
  }
}

async function runEventsRefresh() {
  if (isRefreshingEvents) return readJSON(EVENTS_FILE);
  isRefreshingEvents = true;
  console.log(`[events] Fetching @ ${new Date().toISOString()}`);
  try {
    const events = await fetchAllEvents();
    writeJSON(EVENTS_FILE, events.slice(0, 150));
    console.log(`[events] Done. ${events.length} found.`);
    return events;
  } finally {
    isRefreshingEvents = false;
  }
}

// ---------- API routes ----------

app.get("/api/areas", (req, res) => res.json(AREAS));

function isStale() {
  try {
    const stat = fs.statSync(LATEST_FILE);
    const hours = Number(process.env.FETCH_INTERVAL_HOURS || 2);
    const ageMs = Date.now() - stat.mtimeMs;
    return ageMs > hours * 60 * 60 * 1000;
  } catch {
    return true;
  }
}

app.get("/api/news", async (req, res) => {
  // On free/sleeping hosts the cron may not fire while the app is idle.
  // So: if the cached data is older than the refresh interval, fetch fresh
  // data on-demand before responding. First visitor after a nap "wakes" the
  // feed for everyone.
  if (isStale() && !isRefreshing) {
    await runRefresh();
  }
  const { area } = req.query;
  let items = readJSON(LATEST_FILE);
  if (area) items = items.filter((i) => i.areaId === area);
  res.json(items);
});

app.post("/api/refresh", async (req, res) => {
  const items = await runRefresh();
  res.json({ count: items.length });
});

function isEventsStale() {
  try {
    const stat = fs.statSync(EVENTS_FILE);
    const hours = Number(process.env.EVENTS_FETCH_INTERVAL_HOURS || 6);
    return Date.now() - stat.mtimeMs > hours * 60 * 60 * 1000;
  } catch {
    return true;
  }
}

app.get("/api/events", async (req, res) => {
  if (isEventsStale() && !isRefreshingEvents) {
    await runEventsRefresh();
  }
  const { area } = req.query;
  let items = readJSON(EVENTS_FILE);
  if (area) items = items.filter((i) => i.areaId === area);
  res.json(items);
});

app.post("/api/events/refresh", async (req, res) => {
  const items = await runEventsRefresh();
  res.json({ count: items.length });
});

app.post("/api/subscribe", (req, res) => {
  const { email } = req.body || {};
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ error: "Valid email required" });
  }
  const subs = new Set(readJSON(SUBSCRIBERS_FILE));
  subs.add(email);
  writeJSON(SUBSCRIBERS_FILE, Array.from(subs));
  res.json({ ok: true, total: subs.size });
});

app.get("/api/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ---------- Startup ----------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`North Hyderabad News app running at http://localhost:${PORT}`);
  runRefresh(); // initial fetch on boot

  const hours = Number(process.env.FETCH_INTERVAL_HOURS || 2);
  const cronExpr = `0 */${hours} * * *`;
  cron.schedule(cronExpr, runRefresh);
  console.log(`Scheduled refresh every ${hours} hour(s) (cron: "${cronExpr}")`);

  runEventsRefresh(); // initial fetch on boot
  const eventsHours = Number(process.env.EVENTS_FETCH_INTERVAL_HOURS || 6);
  const eventsCronExpr = `0 */${eventsHours} * * *`;
  cron.schedule(eventsCronExpr, runEventsRefresh);
  console.log(`Scheduled events refresh every ${eventsHours} hour(s) (cron: "${eventsCronExpr}")`);
});
