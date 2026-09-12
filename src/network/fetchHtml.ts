import { isCloudflareChallenge } from '../shared/cloudflare'

const MAX_RETRIES = 40
const RETRY_DELAY_MS = 2500

export { isCloudflareChallenge }

export class FetchHtmlError extends Error {
  kind: 'cloudflare' | 'http' | 'network'

  constructor(message: string, kind: 'cloudflare' | 'http' | 'network') {
    super(message)
    this.name = 'FetchHtmlError'
    this.kind = kind
  }
}

export interface BrowserStatus {
  open: boolean
  scrapingEnabled: boolean
}

export interface SearchPageFetchResult {
  html: string
  finalUrl: string
}

type FetchApiResult =
  | { ok: true; html: string; finalUrl?: string }
  | { ok: false; retry?: boolean; message?: string }

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(new DOMException('Aborted', 'AbortError'))
      },
      { once: true },
    )
  })
}

async function postFetch(
  url: string,
  body: object,
  signal?: AbortSignal,
): Promise<FetchApiResult> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })

  if (!res.ok) {
    throw new FetchHtmlError(`Server error ${res.status}`, 'network')
  }

  return res.json() as Promise<FetchApiResult>
}

async function fetchWithRetries(
  url: string,
  body: object,
  signal?: AbortSignal,
  onRetry?: (message: string, attempt: number) => void,
): Promise<SearchPageFetchResult> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }

    try {
      const data = await postFetch(url, body, signal)

      if (data.ok && 'html' in data && data.html) {
        if (isCloudflareChallenge(data.html)) {
          onRetry?.('Cloudflare in page — complete it in the browser tab', attempt)
          await delay(RETRY_DELAY_MS, signal)
          continue
        }
        return { html: data.html, finalUrl: data.finalUrl ?? '' }
      }

      if (!data.ok && 'retry' in data && data.retry) {
        onRetry?.(data.message ?? 'Waiting for browser…', attempt)
        await delay(RETRY_DELAY_MS, signal)
        continue
      }

      const errMsg = !data.ok && 'message' in data ? data.message : 'Fetch failed'
      throw new FetchHtmlError(errMsg ?? 'Fetch failed', 'network')
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err
      if (err instanceof FetchHtmlError && !err.message.includes('Server error')) throw err

      onRetry?.(
        err instanceof Error ? err.message : 'Connection error — retrying',
        attempt,
      )
      if (attempt >= MAX_RETRIES) {
        throw new FetchHtmlError(
          `Could not reach scraper browser after ${MAX_RETRIES} tries. Is npm run dev running?`,
          'network',
        )
      }
      await delay(RETRY_DELAY_MS, signal)
    }
  }

  throw new FetchHtmlError('Fetch timed out', 'network')
}

export async function getBrowserStatus(): Promise<BrowserStatus> {
  const res = await fetch('/api/dev/browser/status')
  return res.json() as Promise<BrowserStatus>
}

export async function prepareBrowser(searchUrl: string): Promise<void> {
  const res = await fetch('/api/dev/browser/prepare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: searchUrl }),
  })
  const data = (await res.json()) as { ok: boolean; message?: string }
  if (!data.ok) {
    throw new FetchHtmlError(data.message ?? 'Failed to open browser', 'network')
  }
}

export async function beginBrowserScraping(): Promise<void> {
  const res = await fetch('/api/dev/browser/begin', { method: 'POST' })
  const data = (await res.json()) as { ok: boolean; message?: string }
  if (!data.ok) {
    throw new FetchHtmlError(data.message ?? 'Failed to enable scraping', 'network')
  }
}

export async function closeScrapeBrowser(): Promise<void> {
  await fetch('/api/dev/browser/close', { method: 'POST' })
}

export async function fetchCurrentPageHtml(
  signal?: AbortSignal,
  onRetry?: (message: string) => void,
): Promise<SearchPageFetchResult> {
  return fetchWithRetries(
    '/api/dev/fetch/current',
    {},
    signal,
    (msg) => onRetry?.(msg),
  )
}

export async function fetchHtmlWithMeta(
  listAmPath: string,
  signal?: AbortSignal,
  onRetry?: (message: string) => void,
  options?: { dedicatedPage?: boolean },
): Promise<SearchPageFetchResult> {
  const path = listAmPath.startsWith('/') ? listAmPath : `/${listAmPath}`
  const dedicatedPage =
    options?.dedicatedPage ?? (path.startsWith('/item/') || path.startsWith('/user/'))

  return fetchWithRetries(
    '/api/dev/fetch',
    { path, dedicatedPage },
    signal,
    (msg) => onRetry?.(msg),
  )
}

export async function fetchHtml(
  listAmPath: string,
  signal?: AbortSignal,
  onRetry?: (message: string) => void,
  options?: { dedicatedPage?: boolean },
): Promise<string> {
  const result = await fetchHtmlWithMeta(listAmPath, signal, onRetry, options)
  return result.html
}

export async function fetchSearchPageHtml(
  listAmPath: string,
  signal?: AbortSignal,
  onRetry?: (message: string) => void,
): Promise<SearchPageFetchResult> {
  const path = listAmPath.startsWith('/') ? listAmPath : `/${listAmPath}`
  return fetchWithRetries(
    '/api/dev/fetch',
    { path, dedicatedPage: false },
    signal,
    (msg) => onRetry?.(msg),
  )
}
