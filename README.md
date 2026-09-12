# listam-scrape-front

Local list.am scraper UI. Playwright runs on your machine via the Vite dev server plugin — Vercel hosts only the static UI shell; **scraping requires `npm run dev` locally**.

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env
```

Set `VITE_API_URL` and `VITE_INGEST_API_KEY` to your Railway backend.

## Run locally

```bash
npm run dev
```

Open http://localhost:5174 — complete Cloudflare verification in the browser when prompted.

## Sync

After each completed scrape run, data is pushed to the backend automatically. Use **Push to backend** on the Scraper tab for manual sync.

## Deploy (Vercel)

Connect this folder as a Vercel project. The deployed site is a UI reference; scraping still needs local dev.
