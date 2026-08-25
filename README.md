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

## Customizing areas

Edit `areas.js` — each entry is `{ id, label, query }`. `query` is what gets
sent to Google News search, so keep it specific (area name + "Hyderabad")
to avoid noise from same-named places elsewhere in India.

## API endpoints (useful if you want to wire this into Kompally Connect)

- `GET /api/news` — latest deduped articles (add `?area=kompally` to filter)
- `GET /api/areas` — the configured area list
- `POST /api/refresh` — trigger an immediate fetch
- `POST /api/subscribe` — body `{ "email": "..." }` to add an alert
  subscriber
