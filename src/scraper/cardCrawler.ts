import { PAGE_DELAY_MS, MAX_PAGES } from '../config'
import {
  addLog,
  enqueueDetailJob,
  setSearchPagesComplete,
  updatePageProgress,
} from '../db'
import { fetchCurrentPageHtml, fetchSearchPageHtml, FetchHtmlError } from '../network/fetchHtml'
import { parseSearchPage } from '../parsers/searchPage'
import type { SavedSearch, ScrapeRun } from '../types'
import {
  buildPageUrl,
  getListAmSearchPageFromUrl,
  getStartPage,
  isPastLastSearchPage,
  toFetchPath,
} from '../utils/url'
import { formatChangeValue } from '../utils/listingDiff'
import { upsertCardData } from './upsert'

export interface CardCrawlerContext {
  run: ScrapeRun
  search: SavedSearch
  signal: AbortSignal
  queuedDetailIds: Set<string>
  onStateChange?: () => void
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new DOMException('Aborted', 'AbortError'))
      },
      { once: true },
    )
  })
}

export async function runCardCrawler(ctx: CardCrawlerContext): Promise<void> {
  const { run, search, signal, queuedDetailIds } = ctx
  const startPage =
    run.lastCompletedPage > 0 ? run.lastCompletedPage + 1 : getStartPage(search.url)

  await addLog(run.id, 'INFO', 'Starting card crawler')

  let previousPageIds: string[] = []

  for (let page = startPage; page <= MAX_PAGES; page++) {
    if (signal.aborted) return

    const pageUrl = buildPageUrl(search.url, page)
    const fetchPath = toFetchPath(pageUrl)

    const readFromOpenTab = page === startPage && run.lastCompletedPage === 0
    if (readFromOpenTab) {
      await addLog(run.id, 'INFO', `Reading search page ${page} from open tab…`)
    } else {
      await addLog(run.id, 'INFO', `Fetching search page ${page}`)
    }
    ctx.onStateChange?.()

    const onRetry = async (msg: string) => {
      await addLog(run.id, 'INFO', `Waiting: ${msg}`)
    }

    let html: string
    let finalUrl = ''
    try {
      const fetched = readFromOpenTab
        ? await fetchCurrentPageHtml(signal, (m) => void onRetry(m))
        : await fetchSearchPageHtml(fetchPath, signal, (m) => void onRetry(m))
      html = fetched.html
      finalUrl = fetched.finalUrl
    } catch (err) {
      if (err instanceof FetchHtmlError && err.kind === 'cloudflare') {
        await addLog(run.id, 'ERROR', err.message)
      } else if ((err as Error).name === 'AbortError') {
        return
      } else {
        await addLog(run.id, 'ERROR', `Page ${page} failed: ${(err as Error).message}`)
      }
      throw err
    }

    if (finalUrl && isPastLastSearchPage(page, finalUrl)) {
      const served = getListAmSearchPageFromUrl(finalUrl)
      await addLog(
        run.id,
        'INFO',
        `Past last page — requested page ${page}, list.am served page ${served} (${finalUrl})`,
      )
      break
    }

    const result = parseSearchPage(html)
    const pageIds: string[] = []

    if (result.cards.length === 0 && result.isEmptyResults) {
      await addLog(run.id, 'INFO', 'No more listings (empty results)')
      await updatePageProgress(run.id, page, pageIds)
      break
    }

    if (result.cards.length === 0 && !result.hasValidStructure) {
      await addLog(
        run.id,
        'WARN',
        'Expected listing structure not found; List.am layout may have changed',
      )
      throw new Error('Parser layout issue')
    }

    if (result.cards.length === 0) {
      await addLog(
        run.id,
        'WARN',
        'No listings parsed from page (layout may have changed or page still loading)',
      )
      throw new Error('No listings parsed from search page')
    }

    const newOnPage = result.cards.filter((card) => !queuedDetailIds.has(card.id))
    await addLog(
      run.id,
      'INFO',
      `Found ${result.cards.length} listings (${newOnPage.length} new)`,
    )

    for (const card of result.cards) {
      if (signal.aborted) return

      try {
        const upsert = await upsertCardData(run.id, search.id, card)
        pageIds.push(card.id)

        const logSuffix =
          upsert.changes.length > 0
            ? `: ${upsert.changes.map((c) => `${c.field} ${formatChangeValue(c.from)} -> ${formatChangeValue(c.to)}`).join(', ')}`
            : ''

        await addLog(
          run.id,
          'INFO',
          `Listing ${card.id} ${upsert.provisionalStatus}${logSuffix}`,
        )

        if (!queuedDetailIds.has(card.id)) {
          const added = await enqueueDetailJob(run.id, card.id)
          if (added) {
            queuedDetailIds.add(card.id)
          }
        }
      } catch (err) {
        await addLog(run.id, 'WARN', `Card ${card.id} parse failed: ${(err as Error).message}`)
      }
    }

    const duplicatePage =
      pageIds.length > 0 &&
      previousPageIds.length > 0 &&
      pageIds.every((id) => previousPageIds.includes(id))

    if (duplicatePage) {
      await addLog(run.id, 'INFO', 'Duplicate listings page — stopping pagination')
      break
    }

    if (pageIds.length > 0 && newOnPage.length === 0) {
      await addLog(
        run.id,
        'INFO',
        'Page only contains listings from earlier pages — stopping pagination',
      )
      break
    }

    await updatePageProgress(run.id, page, pageIds)
    previousPageIds = pageIds
    ctx.onStateChange?.()

    if (page >= MAX_PAGES) {
      await addLog(run.id, 'WARN', `Reached max page limit (${MAX_PAGES})`)
      break
    }

    await sleep(PAGE_DELAY_MS, signal)
  }

  await setSearchPagesComplete(run.id)
  await addLog(run.id, 'INFO', 'Search pages complete')
  ctx.onStateChange?.()
}
