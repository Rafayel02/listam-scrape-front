import { isLikelyOwnerPost } from './ownerClassification'
import { DETAIL_JOB_DELAY_MS, DETAIL_MAX_RETRIES } from '../config'
import {
  addLog,
  claimDetailJob,
  db,
  incrementDetailRetry,
  isDetailFullyAnalyzed,
  markDetailComplete,
  markDetailFailed,
  releaseAllProcessingJobs,
  releaseDetailJob,
  shouldIncludeListingInOwnerOnlyDetailQueue,
} from '../db'
import { fetchHtml } from '../network/fetchHtml'
import { parseDetailPage } from '../parsers/detailPage'
import { enrichOwnerWithProfileData } from './enrichOwner'
import {
  markListingFailed,
  markListingRemoved,
  setRunListingFailed,
  upsertDetailData,
} from './upsert'

export interface DetailEnricherContext {
  runId: string
  signal: AbortSignal
  onStateChange?: () => void
  isDoneGateReady: () => Promise<boolean>
  onlyOwnerPosts?: boolean
}

function isBrowserClosedError(message: string): boolean {
  return /target page.*closed|browser has been closed|browser was closed/i.test(message)
}

async function processDetailJob(
  runId: string,
  listingId: string,
  signal: AbortSignal,
  onlyOwnerPosts = false,
): Promise<void> {
  const listing = await db.listings.get(listingId)
  if (!listing) {
    await markDetailFailed(runId, listingId)
    await setRunListingFailed(runId, listingId)
    await addLog(runId, 'ERROR', `Detail ${listingId} failed: listing not found`)
    return
  }

  const run = await db.scrapeRuns.get(runId)
  const refreshDetails = run?.refreshDetails === true

  if (!refreshDetails && isDetailFullyAnalyzed(listing)) {
    await markDetailComplete(runId, listingId)
    await addLog(runId, 'INFO', `Detail ${listingId} skipped (already analyzed)`)
    return
  }

  if (onlyOwnerPosts && !(await shouldIncludeListingInOwnerOnlyDetailQueue(listing))) {
    await markDetailComplete(runId, listingId)
    await addLog(runId, 'INFO', `Detail ${listingId} skipped (broker/agency — owner-only)`)
    return
  }

  await db.listings.update(listingId, { enrichmentStatus: 'processing' })

  const fetchPath = `/item/${listingId}`

  try {
    const html = await fetchHtml(fetchPath, signal)
    const detail = parseDetailPage(html)

    if (detail.removed) {
      await markListingRemoved(runId, listingId, {
        searchId: run?.searchId,
        message: detail.removedMessage,
      })
      await markDetailComplete(runId, listingId)
      await addLog(runId, 'INFO', `Detail ${listingId} removed (listing no longer exists)`)
      return
    }

    let ownerOnlyNote = ''
    if (detail.owner) {
      const scrapedCount = await db.listings
        .where('ownerId')
        .equals(detail.owner.id)
        .count()
      const treatAsOwnerPost = isLikelyOwnerPost(detail.owner, Math.max(scrapedCount, 1))

      if (onlyOwnerPosts && !treatAsOwnerPost) {
        ownerOnlyNote = ' (broker/agency — owner-only, no profile fetch)'
      } else {
        detail.owner = await enrichOwnerWithProfileData(detail.owner, signal)
      }
    }

    const result = await upsertDetailData(runId, listingId, detail)
    await markDetailComplete(runId, listingId)

    const suffix =
      result.changes.length > 0
        ? ` (${result.changes.map((c) => `${c.field} changed`).join(', ')})`
        : ''
    await addLog(runId, 'INFO', `Detail ${listingId} complete${suffix}${ownerOnlyNote}`)
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      await releaseDetailJob(runId, listingId)
      await db.listings.update(listingId, { enrichmentStatus: 'pending' })
      return
    }

    const message = err instanceof Error ? err.message : 'Unknown error'
    const retries = await incrementDetailRetry(runId, listingId)

    if (retries <= DETAIL_MAX_RETRIES) {
      await addLog(runId, 'WARN', `Detail ${listingId} retry ${retries}: ${message}`)
      await db.listings.update(listingId, { enrichmentStatus: 'pending' })
      if (isBrowserClosedError(message)) {
        await delay(DETAIL_JOB_DELAY_MS * 2, signal)
      }
      return
    }

    await markDetailFailed(runId, listingId)
    await markListingFailed(listingId, message)
    await setRunListingFailed(runId, listingId)
    await addLog(runId, 'ERROR', `Detail ${listingId} failed: ${message}`)
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
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

async function getNextPendingJob(runId: string): Promise<string | null> {
  const run = await db.scrapeRuns.get(runId)
  if (!run) return null

  for (const id of run.processingDetailIds) {
    if (run.completedDetailIds.includes(id) || run.failedDetailIds.includes(id)) continue
    return id
  }

  for (const id of run.pendingDetailIds) {
    if (run.completedDetailIds.includes(id) || run.failedDetailIds.includes(id)) continue
    const claimed = await claimDetailJob(runId, id)
    if (claimed) return id
  }

  return null
}

function hasPendingDetailWork(run: {
  pendingDetailIds: string[]
  processingDetailIds: string[]
  completedDetailIds: string[]
  failedDetailIds: string[]
}): boolean {
  return (
    run.pendingDetailIds.some(
      (id) => !run.completedDetailIds.includes(id) && !run.failedDetailIds.includes(id),
    ) || run.processingDetailIds.length > 0
  )
}

export async function runDetailEnricher(ctx: DetailEnricherContext): Promise<void> {
  const { runId, signal, onStateChange, isDoneGateReady, onlyOwnerPosts } = ctx

  await addLog(runId, 'INFO', 'Starting detail enricher (sequential)')

  try {
    while (!signal.aborted) {
      const listingId = await getNextPendingJob(runId)

      if (listingId) {
        await processDetailJob(runId, listingId, signal, onlyOwnerPosts)
        onStateChange?.()

        if (DETAIL_JOB_DELAY_MS > 0 && !signal.aborted) {
          try {
            await delay(DETAIL_JOB_DELAY_MS, signal)
          } catch {
            break
          }
        }
        continue
      }

      const run = await db.scrapeRuns.get(runId)
      if (!run) break

      if (!hasPendingDetailWork(run) && run.searchPagesComplete) {
        break
      }

      if (!hasPendingDetailWork(run) && !run.searchPagesComplete) {
        await new Promise((r) => setTimeout(r, 300))
        continue
      }

      await new Promise((r) => setTimeout(r, 100))
    }
  } finally {
    if (signal.aborted) {
      await releaseAllProcessingJobs(runId)
    }
  }

  const ready = await isDoneGateReady()
  if (ready) {
    const run = await db.scrapeRuns.get(runId)
    const remaining =
      (run?.pendingDetailIds.length ?? 0) + (run?.processingDetailIds.length ?? 0)
    if (remaining > 0) {
      await addLog(runId, 'INFO', `Waiting for ${remaining} remaining detail jobs`)
    }
  }

  onStateChange?.()
}
