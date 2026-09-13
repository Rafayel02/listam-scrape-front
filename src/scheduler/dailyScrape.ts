import { DAILY_SCRAPE_CATCH_UP_ON_START, DAILY_SCRAPE_ENABLED } from '../config'
import { scrapeEngine, type DailyBatchResult } from '../scraper/engine'
import {
  formatYerevanDateTime,
  formatYerevanDay,
  msUntilNextYerevanMidnight,
  nextYerevanMidnightMs,
} from './yerevanTime'

const STORAGE_KEY = 'listam-daily-scrape-yerevan-day'
const RETRY_BUSY_MS = 15 * 60 * 1000
const CATCH_UP_DELAY_MS = 30_000

export interface DailyScrapeStatus {
  enabled: boolean
  scheduled: boolean
  batchInProgress: boolean
  lastRunDay: string | null
  nextRunAt: number | null
  lastResult: DailyBatchResult | null
  lastError: string | null
}

type StatusListener = () => void

let timer: ReturnType<typeof setTimeout> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let catchUpTimer: ReturnType<typeof setTimeout> | null = null
let batchInProgress = false
let nextRunAt: number | null = null
let lastResult: DailyBatchResult | null = null
let lastError: string | null = null
const listeners = new Set<StatusListener>()

function notify(): void {
  listeners.forEach((listener) => listener())
}

function getLastRunDay(): string | null {
  return localStorage.getItem(STORAGE_KEY)
}

function markRunDay(day: string): void {
  localStorage.setItem(STORAGE_KEY, day)
}

export function getDailyScrapeStatus(): DailyScrapeStatus {
  return {
    enabled: DAILY_SCRAPE_ENABLED,
    scheduled: timer != null,
    batchInProgress,
    lastRunDay: getLastRunDay(),
    nextRunAt,
    lastResult,
    lastError,
  }
}

export function subscribeDailyScrapeStatus(listener: StatusListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function clearTimer(): void {
  if (timer) clearTimeout(timer)
  timer = null
}

function clearRetryTimer(): void {
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = null
}

function scheduleNextMidnight(): void {
  clearTimer()
  if (!DAILY_SCRAPE_ENABLED) {
    nextRunAt = null
    notify()
    return
  }

  const delay = msUntilNextYerevanMidnight()
  nextRunAt = nextYerevanMidnightMs()
  timer = setTimeout(() => {
    void onYerevanDayChange()
    scheduleNextMidnight()
  }, delay)
  notify()
}

function scheduleRetryBusy(): void {
  clearRetryTimer()
  retryTimer = setTimeout(() => {
    void onYerevanDayChange()
  }, RETRY_BUSY_MS)
}

export async function runDailyScrapeBatch(): Promise<DailyBatchResult> {
  if (batchInProgress) {
    return {
      started: false,
      reason: 'Daily batch already in progress',
      completed: 0,
      failed: 0,
      total: 0,
      results: [],
    }
  }

  if (scrapeEngine.isBusy()) {
    return {
      started: false,
      reason: 'A scrape is already in progress',
      completed: 0,
      failed: 0,
      total: 0,
      results: [],
    }
  }

  batchInProgress = true
  lastError = null
  notify()

  try {
    const result = await scrapeEngine.runAllSavedSearchesSequentially({
      source: 'daily-cron',
    })
    lastResult = result
    if (result.started) {
      markRunDay(formatYerevanDay())
    }
    return result
  } catch (err) {
    lastError = (err as Error).message
    throw err
  } finally {
    batchInProgress = false
    notify()
  }
}

async function onYerevanDayChange(): Promise<void> {
  const day = formatYerevanDay()
  if (getLastRunDay() === day) return

  if (scrapeEngine.isBusy() || batchInProgress) {
    scheduleRetryBusy()
    return
  }

  try {
    await runDailyScrapeBatch()
  } catch (err) {
    lastError = (err as Error).message
    console.error('[daily-scrape] failed:', err)
    notify()
  }
}

function scheduleCatchUpIfNeeded(): void {
  if (!DAILY_SCRAPE_CATCH_UP_ON_START) return
  if (catchUpTimer) clearTimeout(catchUpTimer)

  const day = formatYerevanDay()
  if (getLastRunDay() === day) return

  catchUpTimer = setTimeout(() => {
    void onYerevanDayChange()
  }, CATCH_UP_DELAY_MS)
}

export function startDailyScrapeScheduler(): void {
  if (!DAILY_SCRAPE_ENABLED) {
    nextRunAt = null
    notify()
    return
  }

  scheduleNextMidnight()
  scheduleCatchUpIfNeeded()
  notify()
}

export function stopDailyScrapeScheduler(): void {
  clearTimer()
  clearRetryTimer()
  if (catchUpTimer) clearTimeout(catchUpTimer)
  catchUpTimer = null
  nextRunAt = null
  notify()
}

export function formatNextDailyRun(): string {
  if (!nextRunAt) return 'Not scheduled'
  return formatYerevanDateTime(nextRunAt)
}
