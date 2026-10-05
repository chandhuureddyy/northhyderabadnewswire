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

const HTTP_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 9000);
const MAX_CONCURRENT_AREAS = Math.max(1, Number(process.env.MAX_CONCURRENT_AREAS || 4));
const REFRESH_TIMEOUT_MS = Number(process.env.REFRESH_TIMEOUT_MS || 45000);
const EVENT_MAX_CONCURRENT_AREAS = Math.max(1, Number(process.env.EVENT_MAX_CONCURRENT_AREAS || 2));

const parser = new Parser({
  headers: { "User-Agent": "Mozilla/5.0 (compatible; NorthHydNewsBot/2.0)" },
  timeout: HTTP_TIMEOUT_MS
});

async function withTimeout(promise, ms = HTTP_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
  });
  try { return await Promise.race([promise, timeout]); }
  finally { clearTimeout(timer); }
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runner() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      try { results[index] = await worker(items[index], index); }
      catch (err) { results[index] = []; console.error('[worker]', err.message); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results.flat();
}

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
      snippet: item.contentSnippet || item.content || item.summary || "",
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
      snippet: item.contentSnippet || item.content || item.summary || "",
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
      timeout: HTTP_TIMEOUT_MS
    });
    return (resp.data.articles || []).map((a) => ({
      title: a.title,
      link: a.url,
      source: a.source?.name || "NewsAPI",
      snippet: [a.description, a.content].filter(Boolean).join(" "),
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
      timeout: HTTP_TIMEOUT_MS
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

// ---------- Area relevance ----------
// Search engines can return a generic Hyderabad/India/world story for a
// narrow area query. We must not tag such a result with the area merely
// because that was the query that produced it. RSS/NewsAPI/CSE all expose
// some form of article summary; use that summary plus the headline as the
// first-pass location evidence.

const BASE_AREA_ALIASES = {
  kompally: ["kompally"],
  suchitra: ["suchitra"],
  bowenpally: ["bowenpally", "bowen pally"],
  bollaram: ["bollaram", "bollarum"],
  alwal: ["alwal"],
  gundlapochampally: ["gundlapochampally", "gundla pochampally"],
  dulapally: ["dulapally", "doolapally"],
  quthbullapur: ["quthbullapur"],
  medchal: ["medchal"],
  shamirpet: ["shamirpet"],
  jeedimetla: ["jeedimetla", "jeedimettla"],
  petbasheerabad: ["petbasheerabad", "pet basheerabad", "pet-basheerabad"],
  malkajgiri: ["malkajgiri"],
  kandlakoya: ["kandlakoya"],
  "medchal-district": ["medchal-malkajgiri", "medchal malkajgiri", "medchal"]
};

const AREA_ALIASES = {
  ...BASE_AREA_ALIASES,
  "north-hyderabad": [
    "north hyderabad",
    ...Object.values(BASE_AREA_ALIASES).flat()
  ]
};

function normalizeSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function areaEvidence(item, area) {
  const aliases = AREA_ALIASES[area.id] || [area.label.toLowerCase()];
  const title = normalizeSearchText(item.title);
  const snippet = normalizeSearchText(item.snippet);
  const link = normalizeSearchText(item.link);
  const titleHit = aliases.some(term => title.includes(normalizeSearchText(term)));
  const snippetHit = aliases.some(term => snippet.includes(normalizeSearchText(term)));
  const linkHit = aliases.some(term => link.includes(normalizeSearchText(term).replace(/ /g, "-")));
  return { titleHit, snippetHit, linkHit };
}

function isRelevantToArea(item, area) {
  // North Hyderabad general is intentionally broad, but it still needs
  // evidence of one of our configured local areas.
  const ev = areaEvidence(item, area);
  if (ev.titleHit) return true;
  if (ev.snippetHit) return true;
  if (ev.linkHit) return true;

  // If the article has no area evidence at all, do not label it with the
  // area simply because the search engine returned it. This prevents cases
  // such as Medchal -> Brazil election / Kerala elephant / Nobel Prize.
  return false;
}

function filterResultsForArea(items, area) {
  return items.filter(item => isRelevantToArea(item, area));
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

const TITLE_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "by", "for", "from", "has", "have",
  "in", "into", "is", "its", "of", "on", "or", "that", "the", "their", "this",
  "to", "was", "were", "what", "when", "where", "why", "with", "will", "after",
  "before", "over", "under", "new", "news"
]);

function normalizeTitle(title, item = {}) {
  let value = String(title || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  // Google News commonly appends the publisher to the headline:
  // "Headline - Publisher". Strip that suffix when it matches the source.
  const source = String(item.source || "")
    .replace(/\b(news|com|in|org)\b/gi, " ")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim();
  const parts = value.split(/\s+[-–—|:]\s+/);
  if (parts.length > 1 && source) {
    const tail = parts[parts.length - 1].replace(/[^a-z0-9]+/g, " ").trim();
    if (tail && (tail === source || tail.includes(source) || source.includes(tail))) {
      value = parts.slice(0, -1).join(" ");
    }
  }

  return value.replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function titleTokens(title, item = {}) {
  return new Set(
    normalizeTitle(title, item)
      .split(" ")
      .map(w => w.trim())
      .filter(w => w.length >= 3 && !TITLE_STOPWORDS.has(w))
  );
}

function titleSimilaritySets(a, b) {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  // Iterate over the smaller set for speed.
  const small = a.size <= b.size ? a : b;
  const large = a.size <= b.size ? b : a;
  for (const token of small) if (large.has(token)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

function sourceQuality(item) {
  const providerScore = {
    "newsapi": 40,
    "google-cse": 35,
    "google-news-rss": 30,
    "bing-news-rss": 20
  }[item.provider] || 10;
  const haystack = `${item.source || ""} ${item.link || ""}`.toLowerCase();
  const priority = PRIORITY_DOMAINS.some(domain => haystack.includes(domain.toLowerCase())) ? 15 : 0;
  const generic = /bing news|google news/i.test(item.source || "") ? -5 : 0;
  return providerScore + priority + generic;
}

function mergeDuplicate(existing, candidate) {
  const merged = sourceQuality(candidate) > sourceQuality(existing) ? { ...candidate } : { ...existing };
  const areaIds = new Set([
    ...(existing.areaIds || (existing.areaId ? [existing.areaId] : [])),
    ...(candidate.areaIds || (candidate.areaId ? [candidate.areaId] : []))
  ]);
  const areas = new Set([
    ...(existing.areas || (existing.area ? [existing.area] : [])),
    ...(candidate.areas || (candidate.area ? [candidate.area] : []))
  ]);
  merged.areaIds = Array.from(areaIds);
  merged.areas = Array.from(areas);
  merged.areaId = merged.areaIds[0] || merged.areaId;
  merged.area = merged.areas[0] || merged.area || "North Hyderabad";

  const times = [existing.publishedAt, candidate.publishedAt]
    .filter(Boolean)
    .map(v => new Date(v).getTime())
    .filter(Number.isFinite);
  if (times.length) merged.publishedAt = new Date(Math.max(...times)).toISOString();
  return merged;
}

function canonicalLink(link) {
  if (!link) return "";
  try {
    const u = new URL(String(link));
    // Remove common tracking parameters so the same article isn't split by
    // utm/ref/click identifiers.
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|ref$|referrer$|source$|ocid$|cmpid$|fbclid$|gclid$)/i.test(key)) {
        u.searchParams.delete(key);
      }
    }
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return String(link).trim();
  }
}

function dedupe(items) {
  const out = [];
  const exact = new Map();
  // Inverted token index prevents the old O(n²) comparison across every
  // collected article. Only compare an item with stories sharing meaningful
  // title words.
  const tokenIndex = new Map();

  for (const item of items) {
    if (isJunk(item)) continue;

    const linkKey = canonicalLink(item.link);
    const titleKey = normalizeTitle(item.title, item);
    if (!linkKey && !titleKey) continue;

    const exactKey = titleKey ? `t:${titleKey}` : `u:${linkKey}`;
    const urlExactKey = linkKey ? `u:${linkKey}` : "";
    let existingIndex = exact.get(urlExactKey) ?? exact.get(exactKey);

    if (existingIndex !== undefined) {
      const previous = out[existingIndex];
      out[existingIndex] = mergeDuplicate(previous, item);
      continue;
    }

    const itemTokens = titleTokens(item.title, item);
    let duplicateIndex = -1;
    const candidates = new Set();

    // Use the rarest few title tokens as candidate keys. This keeps the
    // comparison bounded even when thousands of feed results are collected.
    const candidateTokens = [...itemTokens]
      .sort((a, b) => (tokenIndex.get(a)?.size || 0) - (tokenIndex.get(b)?.size || 0))
      .slice(0, 4);
    for (const token of candidateTokens) {
      for (const idx of (tokenIndex.get(token) || [])) candidates.add(idx);
    }

    if (itemTokens.size >= 5) {
      for (const idx of candidates) {
        const other = out[idx];
        if (!other || !other._titleTokens) continue;
        const otherKey = other._titleKey;
        if (titleKey === otherKey || titleSimilaritySets(itemTokens, other._titleTokens) >= 0.84) {
          duplicateIndex = idx;
          break;
        }
      }
    }

    if (duplicateIndex >= 0) {
      out[duplicateIndex] = mergeDuplicate(out[duplicateIndex], item);
      out[duplicateIndex]._titleTokens = titleTokens(out[duplicateIndex].title, out[duplicateIndex]);
      out[duplicateIndex]._titleKey = normalizeTitle(out[duplicateIndex].title, out[duplicateIndex]);
      if (linkKey) exact.set(urlExactKey, duplicateIndex);
      exact.set(exactKey, duplicateIndex);
      continue;
    }

    const stored = {
      ...item,
      areaIds: item.areaIds || (item.areaId ? [item.areaId] : []),
      areas: item.areas || (item.area ? [item.area] : []),
      _titleTokens: itemTokens,
      _titleKey: titleKey
    };
    const index = out.push(stored) - 1;
    if (linkKey) exact.set(urlExactKey, index);
    exact.set(exactKey, index);
    for (const token of itemTokens) {
      if (!tokenIndex.has(token)) tokenIndex.set(token, new Set());
      tokenIndex.get(token).add(index);
    }
  }

  // Never expose the internal dedupe fields in API responses or persisted data.
  return out.map(({ _titleTokens, _titleKey, ...item }) => item);
}

function withinDays(items, days) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return items.filter((item) => !item.publishedAt || new Date(item.publishedAt).getTime() >= cutoff);
}

// ---------- News pipeline ----------

async function fetchAllAreas() {
  const windowDays = Number(process.env.NEWS_WINDOW_DAYS || 15);
  const priorityQuerySuffix = `(site:${PRIORITY_DOMAINS.join(" OR site:")})`;

  return mapWithConcurrency(AREAS, MAX_CONCURRENT_AREAS, async (area) => {
    const [general, bing, newsApi, cse, priorityGoogle, priorityBing] = await Promise.all([
      fetchGoogleNews(area.query),
      fetchBingNews(area.query),
      fetchNewsApi(area.query),
      fetchGoogleCse(area.query, windowDays),
      fetchGoogleNews(`${area.query} ${priorityQuerySuffix}`),
      fetchBingNews(`${area.query} ${priorityQuerySuffix}`)
    ]);
    const candidates = [...general, ...bing, ...newsApi, ...cse, ...priorityGoogle, ...priorityBing];
    const relevant = filterResultsForArea(candidates, area);
    return relevant.map((i) => ({ ...i, area: area.label, areaId: area.id }));
  }).then(results => {
    const deduped = dedupe(results);
    const inWindow = withinDays(deduped, windowDays);
    inWindow.sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
    return inWindow;
  });
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
  '("upcoming event" OR "event" OR "exhibition" OR "expo" OR "festival" OR "concert" OR "fair" OR "workshop" OR "tournament" OR "camp" OR "opening" OR "launch" OR "coming soon" OR "scheduled for" OR "to be held" OR "will be held")';

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


function extractEventDate(item) {
  const text = `${item.title || ''} ${item.snippet || ''}`;
  const months = 'January|February|March|April|May|June|July|August|September|October|November|December';
  const m = text.match(new RegExp(`\\b(${months})\\s+(\\d{1,2})(?:\\s*[-–]\\s*\\d{1,2})?,?\\s*(\\d{4})?\\b`, 'i'));
  if (!m) return null;
  const year = Number(m[3] || (item.publishedAt ? new Date(item.publishedAt).getFullYear() : new Date().getFullYear()));
  const d = new Date(`${m[1]} ${m[2]}, ${year} 23:59:59`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function annotateEvents(items) {
  const now = Date.now();
  // The section is explicitly an UPCOMING events feed. A recent news
  // publication is not an event date. Therefore an item must contain an
  // actual event date and that date must fall within the next N days.
  const horizonDays = Number(process.env.EVENTS_HORIZON_DAYS || 30);
  const horizon = now + horizonDays * 24 * 60 * 60 * 1000;

  return items
    .map(i => ({ ...i, eventDate: extractEventDate(i) }))
    .filter(i => {
      if (!i.eventDate) return false;
      const eventTime = new Date(i.eventDate).getTime();
      return eventTime >= now && eventTime <= horizon;
    })
    .sort((a, b) => {
      const ad = new Date(a.eventDate).getTime();
      const bd = new Date(b.eventDate).getTime();
      return ad - bd || new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0);
    });
}

async function fetchAllEvents() {
  const freshDays = Number(process.env.EVENTS_LOOKBACK_DAYS || 45);
  const cseDays = Math.min(freshDays, 45);

  const results = await mapWithConcurrency(AREAS, EVENT_MAX_CONCURRENT_AREAS, async (area) => {
    const query = `${area.query} ${EVENT_KEYWORDS}`;
    // Keep event discovery deliberately light: Google/Bing RSS are fast and
    // resilient; only fall back to CSE when both return nothing. This avoids
    // launching dozens of simultaneous external requests during Render cold starts.
    const google = await fetchGoogleNews(query);
    const bing = await fetchBingNews(query);
    let cse = [];
    if (!google.length && !bing.length) cse = await fetchGoogleCse(query, cseDays);
    return [...google, ...bing, ...cse].map((i) => ({ ...i, area: area.label, areaId: area.id }));
  });

  const deduped = dedupe(results).filter((i) => !isPastTense(i.title));
  const fresh = withinDays(deduped, freshDays);
  return annotateEvents(fresh);
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
    const all = await withTimeout(fetchAllAreas(), REFRESH_TIMEOUT_MS);
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

    const byArea = all.reduce((acc, item) => {
      for (const areaId of (item.areaIds || (item.areaId ? [item.areaId] : []))) {
        acc[areaId] = (acc[areaId] || 0) + 1;
      }
      return acc;
    }, {});
    console.log(`[refresh] Done. ${all.length} total, ${newItems.length} new. Area counts: ${JSON.stringify(byArea)}`);
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
    const events = await withTimeout(fetchAllEvents(), REFRESH_TIMEOUT_MS);
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
  // Never block a page request on external search providers. Start a refresh
  // in the background and return the last cache immediately.
  if (isStale() && !isRefreshing) runRefresh().catch(err => console.error('[refresh]', err.message));
  const { area } = req.query;
  let items = readJSON(LATEST_FILE);
  if (area) items = items.filter((i) => (i.areaIds || [i.areaId]).includes(area));
  res.json(items);
});

app.post("/api/refresh", (req, res) => {
  if (!isRefreshing) runRefresh().catch(err => console.error('[refresh]', err.message));
  res.status(202).json({ started: true, count: readJSON(LATEST_FILE).length });
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
  if (isEventsStale() && !isRefreshingEvents) runEventsRefresh().catch(err => console.error('[events]', err.message));
  const { area } = req.query;
  let items = readJSON(EVENTS_FILE);
  if (area) items = items.filter((i) => (i.areaIds || [i.areaId]).includes(area));
  res.json(items);
});

app.post("/api/events/refresh", (req, res) => {
  if (!isRefreshingEvents) runEventsRefresh().catch(err => console.error('[events]', err.message));
  res.status(202).json({ started: true, count: readJSON(EVENTS_FILE).length });
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
  // Let the web server become responsive before starting the first external refresh.
  // This is especially important on Render cold starts.
  setTimeout(() => runRefresh().catch(err => console.error('[startup refresh]', err.message)), 1500);

  const hours = Number(process.env.FETCH_INTERVAL_HOURS || 4);
  const cronExpr = `0 */${hours} * * *`;
  cron.schedule(cronExpr, runRefresh);
  console.log(`Scheduled refresh every ${hours} hour(s) (cron: "${cronExpr}")`);

  // Never make the first page load compete with the event collector.
  // The collector starts well after the web server is healthy.
  setTimeout(() => runEventsRefresh().catch(err => console.error('[startup events]', err.message)), 30000);
  const eventsHours = Number(process.env.EVENTS_FETCH_INTERVAL_HOURS || 6);
  const eventsCronExpr = `0 */${eventsHours} * * *`;
  cron.schedule(eventsCronExpr, runEventsRefresh);
  console.log(`Scheduled events refresh every ${eventsHours} hour(s) (cron: "${eventsCronExpr}")`);
});
