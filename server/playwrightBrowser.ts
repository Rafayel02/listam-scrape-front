import { execSync } from 'node:child_process'
import { existsSync, readlinkSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type BrowserContext, type Page } from 'playwright'
import { isCloudflareChallenge } from '../src/shared/cloudflare.js'
import { computePHash } from './imageHash.js'

export interface ImagePhashEntry {
  url: string
  phash: string
}

const LOG_PREFIX = '[listam-scraper]'
const BASE = 'https://www.list.am'
const PROFILE_DIR = join(process.cwd(), '.listam-browser-profile')
const DEBUG_PORT = 9333
const CF_WAIT_MS = 25_000
const DETAIL_DWELL_MIN_MS = 4_000
const DETAIL_DWELL_MAX_MS = 8_000

export type FetchPageResult =
  | { ok: true; html: string; finalUrl: string }
  | { ok: false; retry: true; message: string }
  | { ok: false; retry: false; message: string }

export class BrowserProfileLockedError extends Error {
  readonly profileDir: string

  constructor(profileDir: string) {
    super(
      `Browser profile is locked by another Chromium process.\n` +
        `Profile: ${profileDir}\n` +
        `Fix: quit any "Google Chrome for Testing" windows, then run:\n` +
        `pkill -9 -f "user-data-dir=${profileDir}"`,
    )
    this.name = 'BrowserProfileLockedError'
    this.profileDir = profileDir
  }
}

let context: BrowserContext | null = null
let launching: Promise<BrowserContext> | null = null
let searchPage: Page | null = null
let scrapingEnabled = false
let searchNavigationLock: Promise<void> = Promise.resolve()
let dedicatedPageLock: Promise<void> = Promise.resolve()

function isClosedError(message: string): boolean {
  return /target page.*closed|browser has been closed|browser was closed|browser tab was closed/i.test(
    message,
  )
}

function log(message: string, ...extra: unknown[]): void {
  console.log(`${LOG_PREFIX} ${message}`, ...extra)
}

function logWarn(message: string, ...extra: unknown[]): void {
  console.warn(`${LOG_PREFIX} ${message}`, ...extra)
}

function logError(message: string, ...extra: unknown[]): void {
  console.error(`${LOG_PREFIX} ${message}`, ...extra)
}

function clearContextSingleton(): void {
  context = null
  launching = null
  searchPage = null
}

function isContextAlive(ctx: BrowserContext | null): boolean {
  if (!ctx) return false
  try {
    ctx.pages()
    return true
  } catch {
    return false
  }
}

function attachContextHandlers(ctx: BrowserContext): void {
  ctx.on('close', () => {
    logWarn('Browser context closed — singleton cleared')
    clearContextSingleton()
  })
}

function pickSearchPage(ctx: BrowserContext): Page | null {
  const pages = ctx.pages().filter((p) => !p.isClosed())
  const listAmPage = pages.find((p) => {
    try {
      return p.url().includes('list.am')
    } catch {
      return false
    }
  })
  return listAmPage ?? pages[0] ?? null
}

function removeProfileLocks(): void {
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    const path = join(PROFILE_DIR, name)
    try {
      if (existsSync(path)) unlinkSync(path)
    } catch {
      // ignore
    }
  }
}

function listProfilePids(): number[] {
  const marker = `user-data-dir=${PROFILE_DIR}`
  try {
    const out = execSync(`pgrep -if "${marker}"`, { encoding: 'utf8' })
    return out
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n) && n > 0)
  } catch {
    return []
  }
}

function getLockHolderPid(): number | null {
  const lockPath = join(PROFILE_DIR, 'SingletonLock')
  if (!existsSync(lockPath)) return null
  try {
    const target = readlinkSync(lockPath)
    const match = target.match(/-(\d+)$/)
    return match ? Number(match[1]) : null
  } catch {
    return null
  }
}

function killPid(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    try {
      execSync(`kill -9 ${pid}`, { stdio: 'ignore' })
    } catch {
      // ignore
    }
  }
}

async function releaseStaleProfile(): Promise<void> {
  const pids = new Set<number>(listProfilePids())
  const lockPid = getLockHolderPid()
  if (lockPid) pids.add(lockPid)

  if (pids.size === 0) {
    removeProfileLocks()
    return
  }

  logWarn(`Cleaning ${pids.size} stale Chromium process(es) for profile`)
  for (const pid of pids) killPid(pid)
  try {
    execSync(`pkill -9 -if "user-data-dir=${PROFILE_DIR}"`, { stdio: 'ignore' })
  } catch {
    // no matches
  }

  for (let attempt = 0; attempt < 12; attempt++) {
    if (listProfilePids().length === 0) break
    for (const pid of listProfilePids()) killPid(pid)
    await new Promise((r) => setTimeout(r, 250))
  }

  removeProfileLocks()
  await new Promise((r) => setTimeout(r, 300))
}

function isProfileInUseError(err: unknown): boolean {
  const msg = (err as Error).message?.toLowerCase() ?? ''
  return msg.includes('already in use') || msg.includes('existing browser session')
}

async function tryReconnectViaCdp(): Promise<BrowserContext | null> {
  try {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`)
    const contexts = browser.contexts()
    if (contexts.length === 0) {
      logWarn('CDP connected but no browser contexts found')
      return null
    }

    const ctx = contexts[0]!
    attachContextHandlers(ctx)
    searchPage = pickSearchPage(ctx)
    context = ctx
    log(`Reconnected to existing browser via CDP (port ${DEBUG_PORT})`)
    return ctx
  } catch {
    return null
  }
}

async function launchPersistentContext(): Promise<BrowserContext> {
  log(`Launching persistent context (profile: ${PROFILE_DIR})`)
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: null,
    locale: 'hy-AM',
    args: [
      '--start-maximized',
      '--disable-blink-features=AutomationControlled',
      `--remote-debugging-port=${DEBUG_PORT}`,
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  })

  attachContextHandlers(ctx)
  searchPage = pickSearchPage(ctx)
  log('Persistent browser context ready')
  return ctx
}

async function createPersistentContext(): Promise<BrowserContext> {
  const reconnected = await tryReconnectViaCdp()
  if (reconnected) return reconnected

  try {
    return await launchPersistentContext()
  } catch (err) {
    logError('Browser launch failed', err)
    clearContextSingleton()

    if (!isProfileInUseError(err)) throw err

    logWarn('Profile locked — cleaning stale Chromium processes and retrying once')
    await releaseStaleProfile()

    try {
      const ctx = await launchPersistentContext()
      context = ctx
      return ctx
    } catch (retryErr) {
      logError('Browser launch retry failed', retryErr)
      clearContextSingleton()
      if (isProfileInUseError(retryErr)) {
        throw new BrowserProfileLockedError(PROFILE_DIR)
      }
      throw retryErr
    }
  }
}

/** Singleton persistent BrowserContext for the entire scraper process. */
export async function getBrowserContext(): Promise<BrowserContext> {
  if (isContextAlive(context)) return context!

  if (!launching) {
    launching = createPersistentContext()
      .then((ctx) => {
        context = ctx
        launching = null
        return ctx
      })
      .catch((err) => {
        launching = null
        context = null
        throw err
      })
  }

  return launching
}

export function isBrowserOpen(): boolean {
  return isContextAlive(context)
}

export function isScrapingEnabled(): boolean {
  return scrapingEnabled
}

export function enableScraping(): void {
  if (!isBrowserOpen()) {
    throw new Error('Cannot enable scraping — browser is not open. Click Start first.')
  }
  scrapingEnabled = true
  log('Scraping enabled')
}

export function disableScraping(): void {
  scrapingEnabled = false
  log('Scraping disabled')
}

function randBetween(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

function randInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1))
}

function remainingMs(deadline: number): number {
  return Math.max(0, deadline - Date.now())
}

async function dwellUntilDeadline(deadline: number, page: Page): Promise<void> {
  const left = remainingMs(deadline)
  if (left > 0) await safeDelay(left, page)
}

async function humanScrollDetailPage(page: Page, deadline: number): Promise<void> {
  let lastHeight = 0
  let stagnantRounds = 0
  const reserveMs = 300

  while (remainingMs(deadline) > reserveMs) {
    if (page.isClosed()) return

    const metrics = await page.evaluate(() => ({
      scrollHeight: document.documentElement.scrollHeight,
      scrollTop: window.scrollY,
      clientHeight: window.innerHeight,
    }))

    const bottomSlack = randInt(50, 140)
    const atBottom = metrics.scrollTop + metrics.clientHeight >= metrics.scrollHeight - bottomSlack
    if (atBottom && metrics.scrollHeight === lastHeight) {
      stagnantRounds++
      if (stagnantRounds >= randInt(1, 2)) break
    } else {
      stagnantRounds = 0
    }
    lastHeight = metrics.scrollHeight

    const left = remainingMs(deadline) - reserveMs
    if (left <= 0) break

    if (Math.random() < 0.18 && left > 400) {
      const upFraction = randBetween(0.06, 0.3)
      await page.evaluate((fraction) => {
        window.scrollBy({ top: -window.innerHeight * fraction, behavior: 'smooth' })
      }, upFraction)
      await safeDelay(Math.min(randInt(180, 550), left), page)
    }

    const scrollFraction = randBetween(0.3, 0.95)
    await page.evaluate((fraction) => {
      window.scrollBy({ top: window.innerHeight * fraction, behavior: 'smooth' })
    }, scrollFraction)

    const pause = Math.min(randInt(120, 480), remainingMs(deadline) - reserveMs)
    if (pause > 0) await safeDelay(pause, page)
  }

  if (!page.isClosed() && remainingMs(deadline) > 200) {
    const targetRatio = Math.random() < 0.65 ? 1 : randBetween(0.85, 0.99)
    await page.evaluate((ratio) => {
      const top = document.documentElement.scrollHeight * ratio - window.innerHeight
      window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
    }, targetRatio)
    const finalPause = Math.min(randInt(120, 350), remainingMs(deadline))
    if (finalPause > 0) await safeDelay(finalPause, page)
  }
}

async function safeDelay(ms: number, page?: Page | null): Promise<void> {
  const step = 300
  let remaining = ms
  while (remaining > 0) {
    if (!isContextAlive(context)) throw new Error('Browser context is closed')
    if (page?.isClosed()) throw new Error('Browser page was closed')
    await new Promise((r) => setTimeout(r, Math.min(step, remaining)))
    remaining -= step
  }
}

function toFullUrl(path: string): string {
  if (path.startsWith('http')) return path
  const p = path.startsWith('/') ? path : `/${path}`
  return `${BASE}${p}`
}

function urlsMatch(a: string, b: string): boolean {
  try {
    const ua = new URL(a)
    const ub = new URL(b)
    return ua.hostname === ub.hostname && ua.pathname === ub.pathname
  } catch {
    return a === b
  }
}

async function withSearchNavigationLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = searchNavigationLock
  let release!: () => void
  searchNavigationLock = new Promise((r) => {
    release = r
  })
  await prev
  try {
    return await fn()
  } finally {
    release()
  }
}

async function withDedicatedPageLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = dedicatedPageLock
  let release!: () => void
  dedicatedPageLock = new Promise((r) => {
    release = r
  })
  await prev
  try {
    return await fn()
  } finally {
    release()
  }
}

async function getSearchPage(): Promise<Page> {
  const ctx = await getBrowserContext()
  if (searchPage && !searchPage.isClosed()) return searchPage

  const openPage = pickSearchPage(ctx)
  if (openPage) {
    searchPage = openPage
    return searchPage
  }

  log('Creating shared search page tab')
  searchPage = await ctx.newPage()
  return searchPage
}

const LISTING_SELECTOR =
  'a.category-data-list-grid-card__destination[href*="/item/"], a.fav-item-info-container[href*="/item/"]'

const DETAIL_SELECTOR =
  'h1[itemprop="name"], .post-view-layout, [data-testid="listing-details-title"], .body[itemprop="description"], #po_body, .descr'

const USER_PROFILE_SELECTOR =
  '[data-testid="seller-profile-page"], [data-testid="seller-profile-name"], [data-testid="seller-profile-active-ads"], [data-testid="business-page-category-filter"], [data-testid="seller-profile-identity"], #uinfo'

type WaitMode = 'search' | 'detail' | 'user'

async function waitForPageContent(page: Page, mode: WaitMode, maxMs = 15_000): Promise<void> {
  const selector =
    mode === 'detail'
      ? DETAIL_SELECTOR
      : mode === 'user'
        ? USER_PROFILE_SELECTOR
        : LISTING_SELECTOR
  try {
    await page.waitForSelector(selector, { timeout: maxMs })
  } catch {
    logWarn(`Expected ${mode} content not detected before timeout — reading page anyway`)
  }
}

function waitModeForPath(path: string): WaitMode {
  if (path.includes('/item/')) return 'detail'
  if (path.includes('/user/')) return 'user'
  return 'search'
}

function extractUserIdFromPath(path: string): string | undefined {
  const match = path.match(/\/user\/(\d+)/)
  return match?.[1]
}

function validateUserProfileNavigation(path: string, finalUrl: string): string | undefined {
  const ownerId = extractUserIdFromPath(path)
  if (!ownerId) return undefined
  if (finalUrl.includes(`/user/${ownerId}`)) return undefined

  if (/^https?:\/\/(?:www\.)?list\.am(?:\/(?:am|en|ru))?\/?(?:[?#].*)?$/i.test(finalUrl)) {
    return `Profile unavailable — /user/${ownerId} redirected to homepage`
  }

  return `Profile redirect — expected /user/${ownerId}, got ${finalUrl}`
}

async function waitUntilReady(
  page: Page,
  maxMs = CF_WAIT_MS,
  options?: { mode?: WaitMode },
): Promise<FetchPageResult> {
  const mode = options?.mode ?? 'search'
  const deadline = Date.now() + maxMs

  while (Date.now() < deadline) {
    if (page.isClosed() || !isContextAlive(context)) {
      return { ok: false, retry: true, message: 'Browser was closed' }
    }

    try {
      const html = await page.content()
      if (!isCloudflareChallenge(html)) {
        await waitForPageContent(page, mode)
        if (page.isClosed() || !isContextAlive(context)) {
          return { ok: false, retry: true, message: 'Browser was closed' }
        }
        const readyHtml = await page.content()
        return { ok: true, html: readyHtml, finalUrl: page.url() }
      }
    } catch (err) {
      const message = (err as Error).message
      if (page.isClosed() || isClosedError(message)) {
        return {
          ok: false,
          retry: true,
          message: 'Browser tab was closed before the page finished loading',
        }
      }
      logError('Failed to read page content', err)
      return { ok: false, retry: false, message }
    }

    await safeDelay(2000, page)
  }

  return {
    ok: false,
    retry: true,
    message: 'Still on Cloudflare — complete verification in the browser tab',
  }
}

export async function prepareBrowser(startUrl: string): Promise<void> {
  scrapingEnabled = false
  const page = await getSearchPage()
  const url = toFullUrl(startUrl)

  if (!urlsMatch(page.url(), url)) {
    log(`Navigating search tab to ${url}`)
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 })
    } catch (err) {
      logError('Search tab navigation failed', err)
      throw err
    }
  }

  const result = await waitUntilReady(page, 5 * 60 * 1000)
  if (!result.ok) {
    throw new Error(result.message)
  }
}

/** End a scrape run but keep the shared BrowserContext open. */
export async function endScrapeSession(): Promise<void> {
  disableScraping()
  log('Scrape session ended — shared browser context kept open')
}

/** Close the shared BrowserContext — call only on process shutdown. */
export async function closeBrowser(): Promise<void> {
  disableScraping()

  if (!context) {
    clearContextSingleton()
    return
  }

  log('Closing shared browser context (process shutdown)')
  try {
    await context.close()
  } catch (err) {
    logError('Failed to close browser context', err)
  }

  clearContextSingleton()
}

/** Read the shared search tab — no navigation. */
export async function readCurrentPageHtml(): Promise<FetchPageResult> {
  if (!scrapingEnabled) {
    return { ok: false, retry: false, message: 'Scraping not started' }
  }

  if (!isBrowserOpen()) {
    return { ok: false, retry: false, message: 'Browser is not open — click Start again' }
  }

  return withSearchNavigationLock(async () => {
    const page = await getSearchPage()
    return waitUntilReady(page, CF_WAIT_MS)
  })
}

async function fetchOnDedicatedPage(path: string): Promise<FetchPageResult> {
  return withDedicatedPageLock(async () => {
    const ctx = await getBrowserContext()
    let page: Page | null = null
    let result: FetchPageResult

    try {
      log(`Opening dedicated page tab for ${path}`)
      page = await ctx.newPage()
      const target = toFullUrl(path)
      const current = page.url()

      try {
        await page.goto(target, {
          waitUntil: 'domcontentloaded',
          timeout: 60000,
          referer: current.includes('list.am') ? current : BASE,
        })
        if (!path.includes('/item/')) {
          await safeDelay(randInt(500, 1400), page)
        }
      } catch (err) {
        const message = (err as Error).message
        logError(`Dedicated page navigation failed for ${path}`, err)
        result = {
          ok: false,
          retry: !isClosedError(message),
          message: isClosedError(message)
            ? 'Browser tab was closed before navigation finished'
            : `Navigation slow: ${message}`,
        }
        return result
      }

      if (path.includes('/item/')) {
        const dwellMs = randInt(DETAIL_DWELL_MIN_MS, DETAIL_DWELL_MAX_MS)
        const deadline = Date.now() + dwellMs
        log(`Detail page dwell ${dwellMs}ms: ${path}`)
        await humanScrollDetailPage(page, deadline)
        result = await waitUntilReady(page, remainingMs(deadline), { mode: 'detail' })
        await dwellUntilDeadline(deadline, page)
      } else {
        result = await waitUntilReady(page, CF_WAIT_MS, { mode: waitModeForPath(path) })
        if (result.ok && path.includes('/user/')) {
          const redirectError = validateUserProfileNavigation(path, result.finalUrl)
          if (redirectError) {
            result = { ok: false, retry: false, message: redirectError }
          }
        }
      }
    } catch (err) {
      const message = (err as Error).message
      logError(`Dedicated page operation failed for ${path}`, err)
      result = {
        ok: false,
        retry: isClosedError(message),
        message,
      }
    } finally {
      if (page && !page.isClosed()) {
        try {
          await page.close()
          log(`Closed dedicated page tab for ${path}`)
        } catch (err) {
          logWarn(`Failed to close dedicated page for ${path}`, err)
        }
      }
    }

    return result
  })
}

/** Fetch one item page for manual testing — does not require an active scrape run. */
/** Fetch listing images through the Playwright session (list.am blocks datacenter IPs). */
export async function hashImagesViaBrowser(urls: string[]): Promise<ImagePhashEntry[]> {
  const ctx = await getBrowserContext()
  const unique = [...new Set(urls.filter((url) => url.trim().length > 0))]
  const results: ImagePhashEntry[] = []

  for (const raw of unique) {
    const url = raw.startsWith('http') ? raw : raw.startsWith('//') ? `https:${raw}` : `${BASE}${raw}`
    try {
      const response = await ctx.request.get(url, {
        headers: { Referer: `${BASE}/`, Accept: 'image/*' },
        timeout: 25_000,
      })
      if (!response.ok()) {
        logWarn(`Image fetch ${response.status()} for ${url}`)
        continue
      }
      const phash = await computePHash(Buffer.from(await response.body()))
      results.push({ url, phash })
    } catch (err) {
      logWarn(`Failed to hash image ${url}`, err)
    }
  }

  return results
}

export async function scrapeItemPage(listingId: string): Promise<FetchPageResult> {
  log(`Manual item scrape: ${listingId}`)
  await getBrowserContext()
  return fetchOnDedicatedPage(`/item/${listingId}`)
}

export async function fetchHtmlViaBrowser(
  path: string,
  options?: { dedicatedPage?: boolean },
): Promise<FetchPageResult> {
  if (!scrapingEnabled) {
    return { ok: false, retry: false, message: 'Scraping not started' }
  }

  if (!isBrowserOpen()) {
    return { ok: false, retry: false, message: 'Browser is not open — click Start again' }
  }

  if (options?.dedicatedPage) {
    return fetchOnDedicatedPage(path)
  }

  return withSearchNavigationLock(async () => {
    const page = await getSearchPage()
    const target = toFullUrl(path)
    const current = page.url()

    if (!urlsMatch(current, target)) {
      log(`Navigating search tab to ${target}`)
      try {
        await page.goto(target, {
          waitUntil: 'domcontentloaded',
          timeout: 60000,
          referer: current.includes('list.am') ? current : BASE,
        })
        await safeDelay(800, page)
      } catch (err) {
        logError(`Search tab navigation failed for ${path}`, err)
        return {
          ok: false,
          retry: true,
          message: `Navigation slow: ${(err as Error).message}`,
        }
      }
    }

    return waitUntilReady(page, CF_WAIT_MS)
  })
}
