# North Hyderabad News Wire

A hyperlocal news aggregator for Kompally, Suchitra, Bowenpally, Bollaram, Alwal,
Gundlapochampally, Dulapally, Quthbullapur, Medchal, Shamirpet, Jeedimetla and
nearby North Hyderabad areas — with an optional email digest whenever new
articles show up.

## How it works

- **Sources**: Google News RSS (no API key, no rate limit issues) run
  **server-side** so there's no CORS problem, plus an optional NewsAPI.org feed
  if you add a key. One search query per area (edit `areas.js` to add/remove
  areas).
- **Dedup**: articles are matched by link so the same story from multiple
  areas/providers doesn't show twice.
- **Refresh**: fetches on boot, then on a cron schedule (default every 2
  hours — change `FETCH_INTERVAL_HOURS` in `.env`). You can also hit
  "Refresh now" on the dashboard.
- **Email alerts**: when a refresh finds articles not seen before, it emails
  a digest to whoever subscribed on the dashboard (or the `NOTIFY_TO`
  address in `.env` if nobody's subscribed yet).

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env`:

- Leave `NEWSAPI_KEY` blank to run on Google News RSS alone — this is enough
  to get started with zero signup.
- To enable email alerts, set `EMAIL_ENABLED=true` and fill in your SMTP
  details. For Gmail: turn on 2FA, then create an **App Password** at
  https://myaccount.google.com/apppasswords and use that as `SMTP_PASS`.

Run it:

```bash
npm start
```

Then open **http://localhost:3000** in your browser.

## Deploying so it's live and reachable from anywhere

GitHub Pages (which you've used for Kompally Connect before) **won't work
for this** — it only serves static files and can't run the server-side
fetch logic. This needs an actual Node.js host. Render.com's free tier is
the easiest path. Steps:

1. **Push this folder to a GitHub repo** (new, empty repo is fine):
   ```bash
   cd north-hyd-news
   git init
   git add .
   git commit -m "North Hyderabad news wire"
   git branch -M main
   git remote add origin https://github.com/<you>/north-hyd-news.git
   git push -u origin main
   ```

2. **Create a Render account** at render.com (free, sign in with GitHub).

3. **New → Web Service**, pick the repo you just pushed.

4. Configure:
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: Free

5. **Environment variables** — add these under the service's "Environment"
   tab (same names as `.env`):
   - `EMAIL_ENABLED` = `false`
   - `FETCH_INTERVAL_HOURS` = `2`
   - `NEWSAPI_KEY` = *(leave blank, not required)*

   Don't set `PORT` — Render sets it automatically and the app already
   reads `process.env.PORT`.

6. Click **Create Web Service**. Render builds and deploys it, then gives
   you a public URL like `https://north-hyd-news.onrender.com` — that's
   your live site, reachable from any device, anywhere.

### About the free tier "sleeping"

Render's free web services go to sleep after ~15 minutes of no visitors,
and take 30-60 seconds to wake up on the next visit. Two things make this
a non-issue here:

- The app **auto-refreshes the feed on-demand** if the cached data is
  older than `FETCH_INTERVAL_HOURS` — so the first visitor after a nap
  triggers a fresh fetch instead of showing stale data.
- If you want it to *never* sleep and to keep fetching in the background
  even with zero visitors (e.g. for a genuinely "always current" feed),
  upgrade that one service to Render's Starter plan (~$7/month) — no code
  changes needed, just flip the instance type.

### Custom domain (optional)

Once deployed, Render lets you attach a custom domain (e.g.
`news.kompallyconnect.com`) for free under the service's "Settings →
Custom Domains" — just add the CNAME record they give you at your domain
registrar.

## Making sure specific publishers show up

For each area, the app now also runs a second, `site:`-scoped search
against The Hindu, The New Indian Express, and Telangana Today
specifically (`priority-sources.js` — add or remove domains there), in
addition to the general search. This makes it much more likely those
publishers' hyperlocal coverage gets picked up, since a general search
for a narrow area name can otherwise bury or skip a specific outlet even
when they've covered it.

One honest limit: if none of those three have actually published anything
that mentions the area recently, nothing will show for them — that's a
content-availability gap, not something more querying can fix.

## Upcoming in North Hyderabad (next ~7 days)

A second, separate feed tries to surface openings, events, and government
notices. This is **not a structured events calendar** — there's no public
API for "list of GHMC/HMDA events happening this week" — so this works by
searching each area for actual future-tense phrasing ("to be inaugurated",
"set to open", "scheduled for", "GHMC notification", etc.) rather than
just topic keywords. Topic keywords alone (e.g. "inaugurated", "launch",
"metro") mostly surfaced regular news, since journalism commonly uses
present tense for things that *just* happened ("X inaugurates new
facility" = already done, not upcoming) — the query now requires an
actual forward-looking phrase, and anything that also reads as a
completed action (e.g. contains "inaugurates", "was held", "completed")
gets dropped even if it matched.

What this means in practice:
- It surfaces **leads to check**, not confirmed dates — always click
  through to the source for the actual date/venue.
- It can miss a real event if nobody's written about it in that specific
  phrasing yet — tightening the language for precision trades away some
  recall.
- It can surface an older recurring notice if it was re-published
  recently.

Refreshes on its own schedule (`EVENTS_FETCH_INTERVAL_HOURS`, default
every 6 hours) via `/api/events`, shown in its own "Upcoming" section
below the main feed on the dashboard.

## Filtering out junk results

Search feeds occasionally return things that technically matched the
query but aren't real articles — a publisher's tag/category archive page
(e.g. `telanganatoday.com/tag/some-topic`, whose page title is just the
tag name), an epaper reader link (a generic paginated viewer, not a
specific article), or a generic feed/wire-service title like "Latest
News - Telangana Today" or "United News of India - United News of India"
instead of an actual headline. These get filtered out automatically
before anything reaches the dashboard or an email digest (see `isJunk()`
in `server.js`, near the top of the fetch pipeline) — by URL pattern
(`/tag/`, `/category/`, `/author/`, etc.) and by title pattern (generic
"Latest News -" titles, or a title that's just a url-slug with no
spaces). If you spot another recurring junk pattern, it's a one-line
addition to `JUNK_URL_PATTERN` or `JUNK_TITLE_PATTERNS`.

## Sources & the 15-day window

Three sources feed the wire, combined and deduped:

- **Google News RSS** (default, no setup) — Google's News-tagged publishers.
- **Bing News RSS** (default, no setup) — a different index, catches
  outlets Google News misses.
- **Google Custom Search** (optional, `GOOGLE_CSE_KEY` + `GOOGLE_CSE_CX`)
  — this is the one that actually behaves like typing the area name into
  google.com: it returns whatever Google has indexed for that query —
  blogs, forums, government/municipal notices, PDFs — not just outlets
  tagged as "News", and shows a text snippet the same way search results
  do. Setup: create an API key at console.cloud.google.com (enable
  "Custom Search API"), then create a search engine at
  programmablesearchengine.google.com with "Search the entire web" turned
  on, and copy its Search engine ID as `GOOGLE_CSE_CX`. Free tier is 100
  queries/day — with 16 areas configured, keep `FETCH_INTERVAL_HOURS` at
  4 or higher once this is on, or it'll run out partway through the day.
- **NewsAPI.org** (optional, `NEWSAPI_KEY`) — as before.

None of this needs a subscription on your end — these are the same public
search results/snippets anyone gets browsing directly, just pulled
automatically per area instead of you searching each one by hand.

**15-day window**: only items from the last 15 days are shown
(`NEWS_WINDOW_DAYS` in `.env`, change the number to widen/narrow it). For
Google News/Bing/NewsAPI this is enforced by filtering on each article's
published date. For Google CSE (which often doesn't expose a reliable
publish date) it's enforced by Google's own `dateRestrict` search
parameter instead, so the same 15-day cutoff still applies.

## Customizing areas

Edit `areas.js` — each entry is `{ id, label, query }`. `query` is what gets
sent to Google News search, so keep it specific (area name + "Hyderabad")
to avoid noise from same-named places elsewhere in India.

## API endpoints (useful if you want to wire this into Kompally Connect)

- `GET /api/news` — latest deduped articles (add `?area=kompally` to filter)
- `GET /api/events` — upcoming-event leads (add `?area=kompally` to filter)
- `GET /api/areas` — the configured area list
- `POST /api/refresh` — trigger an immediate news fetch
- `POST /api/events/refresh` — trigger an immediate events fetch
- `POST /api/subscribe` — body `{ "email": "..." }` to add an alert
  subscriber
