require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const axios = require("axios");
const cron = require("node-cron");
const nodemailer = require("nodemailer");
const Parser = require("rss-parser");

const AREAS = require("./areas");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const parser = new Parser({
  headers: { "User-Agent": "Mozilla/5.0 (compatible; NorthHydNewsBot/1.0)" }
});

const DATA_DIR = path.join(__dirname, "data");
const SEEN_FILE = path.join(DATA_DIR, "seen.json");
const LATEST_FILE = path.join(DATA_DIR, "latest.json");
const SUBSCRIBERS_FILE = path.join(DATA_DIR, "subscribers.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
for (const f of [SEEN_FILE, LATEST_FILE, SUBSCRIBERS_FILE]) {
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

// ---------- Fetchers ----------

async function fetchGoogleNewsForArea(area) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(
    area.query
  )}&hl=en-IN&gl=IN&ceid=IN:en`;

  try {
    const feed = await parser.parseURL(url);
    return (feed.items || []).map((item) => ({
      title: item.title,
      link: item.link,
      source: (item.title && item.title.split(" - ").pop()) || "Google News",
      publishedAt: item.pubDate ? new Date(item.pubDate).toISOString() : null,
      area: area.label,
      areaId: area.id,
      provider: "google-news-rss"
    }));
  } catch (err) {
    console.error(`[google-news] ${area.label} failed:`, err.message);
    return [];
  }
}

async function fetchNewsApiForArea(area) {
  const key = process.env.NEWSAPI_KEY;
  if (!key) return [];

  try {
    const resp = await axios.get("https://newsapi.org/v2/everything", {
      params: {
        q: area.query,
        language: "en",
        sortBy: "publishedAt",
        pageSize: 15,
        apiKey: key
      },
      timeout: 10000
    });
    return (resp.data.articles || []).map((a) => ({
      title: a.title,
      link: a.url,
      source: a.source?.name || "NewsAPI",
      publishedAt: a.publishedAt,
      area: area.label,
      areaId: area.id,
      provider: "newsapi"
    }));
  } catch (err) {
    console.error(`[newsapi] ${area.label} failed:`, err.message);
    return [];
  }
}

async function fetchAllAreas() {
  const results = [];
  for (const area of AREAS) {
    const [googleItems, newsApiItems] = await Promise.all([
      fetchGoogleNewsForArea(area),
      fetchNewsApiForArea(area)
    ]);
    results.push(...googleItems, ...newsApiItems);
    // small stagger so we don't hammer google in a tight loop
    await new Promise((r) => setTimeout(r, 250));
  }

  // Dedup by link (fallback to title) across all areas/providers
  const seenKeys = new Set();
  const deduped = [];
  for (const item of results) {
    const key = item.link || item.title;
    if (!key || seenKeys.has(key)) continue;
    seenKeys.add(key);
    deduped.push(item);
  }

  deduped.sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
  return deduped;
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
});
