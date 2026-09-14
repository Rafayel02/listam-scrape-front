// Detail pages are fetched one at a time (sequential dedicated tabs)
export const DETAIL_JOB_DELAY_MS = 1000
export const OWNER_PROFILE_JOB_DELAY_MS = 1000
export const MAX_PAGES = 200
export const PAGE_DELAY_MS = 500
export const DETAIL_MAX_RETRIES = 2
/** Owners with this many scraped listings are classified as likely brokers. */
export const BROKER_LISTING_THRESHOLD = 4
/** Push local Dexie data to Railway on this interval while the app is open. */
export const BACKEND_SYNC_INTERVAL_MS = 3 * 60 * 1000
/**
 * Max JSON body size per /api/ingest request.
 * Keep under common reverse-proxy limits (often 1mb) to avoid 413 Payload Too Large.
 */
export const INGEST_MAX_BATCH_BYTES = 512 * 1024
/** Run all saved searches once per Yerevan calendar day while the app is open. */
export const DAILY_SCRAPE_ENABLED = import.meta.env.VITE_DAILY_SCRAPE_ENABLED !== 'false'
/** If the app opens on a new Yerevan day, run the daily batch after a short delay. */
export const DAILY_SCRAPE_CATCH_UP_ON_START = import.meta.env.VITE_DAILY_SCRAPE_CATCH_UP !== 'false'
