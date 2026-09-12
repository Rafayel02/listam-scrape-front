import Dexie, { type EntityTable } from 'dexie'
import { isLikelyOwnerPost } from './scraper/ownerClassification'
import type {
  Listing,
  ListingChange,
  Owner,
  RunCounters,
  RunListingStatusRecord,
  SavedSearch,
  ScrapeLog,
  ScrapeRun,
  SearchListing,
} from './types'

class ListAmDB extends Dexie {
  searches!: EntityTable<SavedSearch, 'id'>
  listings!: EntityTable<Listing, 'id'>
  owners!: EntityTable<Owner, 'id'>
  searchListings!: EntityTable<SearchListing, 'id'>
  scrapeRuns!: EntityTable<ScrapeRun, 'id'>
  runListingStatuses!: EntityTable<RunListingStatusRecord, 'id'>
  scrapeLogs!: EntityTable<ScrapeLog, 'id'>
  listingChanges!: EntityTable<ListingChange, 'id'>

  constructor() {
    super('listam-scraper')
    this.version(1).stores({
      searches: 'id, createdAt',
      listings: 'id, lastSeenAt, lastChangedAt',
      searchListings: 'id, searchId, listingId, isPresent',
      scrapeRuns: 'id, searchId, status, startedAt',
      runListingStatuses: 'id, runId, listingId, status',
      scrapeLogs: '++id, runId, timestamp',
      listingChanges: '++id, listingId, scrapeRunId, changedAt',
    })
    this.version(2)
      .stores({
        searches: 'id, createdAt',
        listings: 'id, lastSeenAt, lastChangedAt',
        searchListings: 'id, searchId, listingId, isPresent',
        scrapeRuns: 'id, searchId, status, startedAt',
        runListingStatuses: 'id, runId, listingId, status',
        scrapeLogs: '++id, runId, timestamp',
        listingChanges: '++id, listingId, scrapeRunId, changedAt',
      })
      .upgrade((tx) =>
        tx
          .table('scrapeRuns')
          .toCollection()
          .modify((run) => {
            if (run.awaitingUserReady === undefined) {
              run.awaitingUserReady = false
            }
          }),
      )
    this.version(3).stores({
      searches: 'id, createdAt',
      listings: 'id, ownerId, lastSeenAt, lastChangedAt',
      owners: 'id, name, lastSeenAt, lastChangedAt',
      searchListings: 'id, searchId, listingId, isPresent',
      scrapeRuns: 'id, searchId, status, startedAt',
      runListingStatuses: 'id, runId, listingId, status',
      scrapeLogs: '++id, runId, timestamp',
      listingChanges: '++id, listingId, scrapeRunId, changedAt',
    })
  }
}

export const db = new ListAmDB()

export function searchListingId(searchId: string, listingId: string): string {
  return `${searchId}:${listingId}`
}

export function runListingStatusId(runId: string, listingId: string): string {
  return `${runId}:${listingId}`
}

export async function addLog(
  runId: string,
  level: ScrapeLog['level'],
  message: string,
): Promise<void> {
  await db.scrapeLogs.add({ runId, level, message, timestamp: Date.now() })
}

export async function getRunCounters(runId: string): Promise<RunCounters> {
  const [statuses, run] = await Promise.all([
    db.runListingStatuses.where('runId').equals(runId).toArray(),
    db.scrapeRuns.get(runId),
  ])

  return {
    created: statuses.filter((s) => s.status === 'CREATED').length,
    updated: statuses.filter((s) => s.status === 'UPDATED').length,
    unchanged: statuses.filter((s) => s.status === 'UNCHANGED').length,
    failed: statuses.filter((s) => s.status === 'FAILED').length,
    discovered: run?.discoveredListingIds.length ?? 0,
    detailsProcessed: run?.completedDetailIds.length ?? 0,
  }
}

function hasDetailJob(run: ScrapeRun, listingId: string): boolean {
  return (
    run.pendingDetailIds.includes(listingId) ||
    run.processingDetailIds.includes(listingId) ||
    run.completedDetailIds.includes(listingId) ||
    run.failedDetailIds.includes(listingId)
  )
}

export async function enqueueDetailJob(
  runId: string,
  listingId: string,
): Promise<boolean> {
  let added = false
  await db.scrapeRuns.where('id').equals(runId).modify((run) => {
    if (hasDetailJob(run, listingId)) return
    run.pendingDetailIds.push(listingId)
    added = true
  })
  return added
}

export async function claimDetailJob(
  runId: string,
  listingId: string,
): Promise<boolean> {
  let claimed = false
  await db.scrapeRuns.where('id').equals(runId).modify((run) => {
    const idx = run.pendingDetailIds.indexOf(listingId)
    if (idx === -1) return
    run.pendingDetailIds.splice(idx, 1)
    if (!run.processingDetailIds.includes(listingId)) {
      run.processingDetailIds.push(listingId)
    }
    claimed = true
  })
  return claimed
}

export async function markDetailComplete(
  runId: string,
  listingId: string,
): Promise<void> {
  await db.scrapeRuns.where('id').equals(runId).modify((run) => {
    run.processingDetailIds = run.processingDetailIds.filter((id) => id !== listingId)
    if (!run.completedDetailIds.includes(listingId)) {
      run.completedDetailIds.push(listingId)
    }
  })
}

export async function markDetailFailed(
  runId: string,
  listingId: string,
): Promise<void> {
  await db.scrapeRuns.where('id').equals(runId).modify((run) => {
    run.processingDetailIds = run.processingDetailIds.filter((id) => id !== listingId)
    run.pendingDetailIds = run.pendingDetailIds.filter((id) => id !== listingId)
    if (!run.failedDetailIds.includes(listingId)) {
      run.failedDetailIds.push(listingId)
    }
  })
}

/** Move one job from processing back to pending (abort / tab closed). */
export async function releaseDetailJob(runId: string, listingId: string): Promise<void> {
  await db.scrapeRuns.where('id').equals(runId).modify((run) => {
    run.processingDetailIds = run.processingDetailIds.filter((id) => id !== listingId)
    if (
      !run.pendingDetailIds.includes(listingId) &&
      !run.completedDetailIds.includes(listingId) &&
      !run.failedDetailIds.includes(listingId)
    ) {
      run.pendingDetailIds.push(listingId)
    }
  })
}

export function isDetailFullyAnalyzed(listing: Listing | undefined): boolean {
  if (!listing) return false
  if (listing.enrichmentStatus === 'removed' || listing.isRemoved) return true
  return listing.enrichmentStatus === 'complete' && !!listing.ownerId
}

/** Release every in-flight detail job so a cancelled/interrupted run can resume. */
/** Move listings that already have detail data out of the pending/processing queues. */
export async function skipAlreadyAnalyzedDetails(runId: string): Promise<number> {
  const run = await db.scrapeRuns.get(runId)
  if (!run) return 0
  if (run.refreshDetails) return 0

  const queueIds = [...new Set([...run.pendingDetailIds, ...run.processingDetailIds])]
  const toSkip: string[] = []
  const toKeep: string[] = []
  const toRequeue: string[] = []

  for (const listingId of queueIds) {
    if (run.failedDetailIds.includes(listingId)) {
      toKeep.push(listingId)
      continue
    }

    const listing = await db.listings.get(listingId)
    if (isDetailFullyAnalyzed(listing)) {
      toSkip.push(listingId)
    } else {
      toKeep.push(listingId)
      if (
        listing?.enrichmentStatus === 'complete' &&
        !listing.ownerId &&
        !listing.isRemoved
      ) {
        await db.listings.update(listingId, { enrichmentStatus: 'pending' })
      }
    }
  }

  for (const listingId of run.completedDetailIds) {
    const listing = await db.listings.get(listingId)
    if (
      listing?.enrichmentStatus === 'complete' &&
      !listing.ownerId &&
      !listing.isRemoved
    ) {
      toRequeue.push(listingId)
      await db.listings.update(listingId, { enrichmentStatus: 'pending' })
    }
  }

  await db.scrapeRuns.where('id').equals(runId).modify((r) => {
    r.processingDetailIds = []
    r.pendingDetailIds = [...new Set([...toKeep, ...toRequeue])]
    for (const id of toSkip) {
      if (!r.completedDetailIds.includes(id)) {
        r.completedDetailIds.push(id)
      }
    }
    r.completedDetailIds = r.completedDetailIds.filter((id) => !toRequeue.includes(id))
  })

  return toSkip.length
}

export async function requeueListingForDetail(
  runId: string,
  listingId: string,
): Promise<boolean> {
  let added = false
  await db.scrapeRuns.where('id').equals(runId).modify((run) => {
    run.completedDetailIds = run.completedDetailIds.filter((id) => id !== listingId)
    run.failedDetailIds = run.failedDetailIds.filter((id) => id !== listingId)
    run.processingDetailIds = run.processingDetailIds.filter((id) => id !== listingId)
    if (!run.pendingDetailIds.includes(listingId)) {
      run.pendingDetailIds.push(listingId)
      added = true
    }
  })
  return added
}

export interface DetailQueueOptions {
  /** Only queue listings from likely private sellers (not brokers/agencies). */
  onlyOwnerPosts?: boolean
}

async function countScrapedPostsForOwner(ownerId: string): Promise<number> {
  return db.listings.where('ownerId').equals(ownerId).count()
}

export async function shouldIncludeListingInOwnerOnlyDetailQueue(
  listing: Listing,
): Promise<boolean> {
  if (!listing.ownerId) return true

  const owner = await db.owners.get(listing.ownerId)
  if (!owner) return true

  const scrapedCount = await countScrapedPostsForOwner(listing.ownerId)
  return isLikelyOwnerPost(owner, scrapedCount)
}

async function listingNeedsDetailAnalysis(
  listing: Listing | undefined,
  options?: DetailQueueOptions,
): Promise<boolean> {
  if (!listing || isDetailFullyAnalyzed(listing)) return false
  if (!options?.onlyOwnerPosts) return true
  return shouldIncludeListingInOwnerOnlyDetailQueue(listing)
}

export async function countListingsNeedingDetail(
  searchId: string,
  options?: DetailQueueOptions,
): Promise<number> {
  const rows = await db.searchListings.where('searchId').equals(searchId).toArray()
  let count = 0
  for (const row of rows) {
    const listing = await db.listings.get(row.listingId)
    if (listing && await listingNeedsDetailAnalysis(listing, options)) {
      count++
    }
  }
  return count
}

/** Remove broker/agency listings from the detail queue (owner-only mode). */
export async function skipNonOwnerPostsFromDetailQueue(runId: string): Promise<number> {
  const run = await db.scrapeRuns.get(runId)
  if (!run) return 0

  const queueIds = [...new Set([...run.pendingDetailIds, ...run.processingDetailIds])]
  let skipped = 0

  for (const listingId of queueIds) {
    const listing = await db.listings.get(listingId)
    if (!listing) continue
    if (await shouldIncludeListingInOwnerOnlyDetailQueue(listing)) continue

    await markDetailComplete(runId, listingId)
    await addLog(runId, 'INFO', `Detail ${listingId} skipped (broker/agency — owner-only)`)
    skipped++
  }

  return skipped
}

/** Ensure run queue includes every listing for this search that still needs detail data. */
export async function syncDetailQueueFromListings(
  runId: string,
  searchId: string,
  options?: DetailQueueOptions,
): Promise<number> {
  const rows = await db.searchListings.where('searchId').equals(searchId).toArray()
  let synced = 0
  for (const row of rows) {
    const listing = await db.listings.get(row.listingId)
    if (listing && await listingNeedsDetailAnalysis(listing, options)) {
      if (await requeueListingForDetail(runId, row.listingId)) {
        synced++
      }
    }
  }
  return synced
}

export async function releaseAllProcessingJobs(runId: string): Promise<void> {
  await db.scrapeRuns.where('id').equals(runId).modify((run) => {
    for (const id of run.processingDetailIds) {
      if (
        !run.pendingDetailIds.includes(id) &&
        !run.completedDetailIds.includes(id) &&
        !run.failedDetailIds.includes(id)
      ) {
        run.pendingDetailIds.push(id)
      }
    }
    run.processingDetailIds = []
  })
}

export async function incrementDetailRetry(
  runId: string,
  listingId: string,
): Promise<number> {
  let count = 0
  await db.scrapeRuns.where('id').equals(runId).modify((run) => {
    count = (run.detailRetryCounts[listingId] ?? 0) + 1
    run.detailRetryCounts[listingId] = count
    run.processingDetailIds = run.processingDetailIds.filter((id) => id !== listingId)
    if (!run.pendingDetailIds.includes(listingId)) {
      run.pendingDetailIds.push(listingId)
    }
  })
  return count
}

export async function updatePageProgress(
  runId: string,
  page: number,
  discoveredIds: string[],
): Promise<void> {
  await db.scrapeRuns.where('id').equals(runId).modify((run) => {
    run.currentPage = page
    run.lastCompletedPage = page
    for (const id of discoveredIds) {
      if (!run.discoveredListingIds.includes(id)) {
        run.discoveredListingIds.push(id)
      }
    }
  })
}

export async function setSearchPagesComplete(runId: string): Promise<void> {
  await db.scrapeRuns.where('id').equals(runId).modify((run) => {
    run.searchPagesComplete = true
  })
}

export async function setRunStatus(
  runId: string,
  status: ScrapeRun['status'],
  finishedAt?: number,
): Promise<void> {
  await db.scrapeRuns.where('id').equals(runId).modify((run) => {
    run.status = status
    if (finishedAt !== undefined) {
      run.finishedAt = finishedAt
    }
  })
}

export async function setAwaitingUserReady(
  runId: string,
  awaiting: boolean,
): Promise<void> {
  await db.scrapeRuns.where('id').equals(runId).modify((run) => {
    run.awaitingUserReady = awaiting
  })
}

export async function markInterruptedRuns(): Promise<ScrapeRun[]> {
  const running = await db.scrapeRuns.where('status').equals('running').toArray()
  for (const run of running) {
    await releaseAllProcessingJobs(run.id)
    await setRunStatus(run.id, 'interrupted')
  }
  return running
}

export async function updatePresenceAfterSuccessfulCrawl(
  searchId: string,
  discoveredIds: string[],
  runId?: string,
): Promise<number> {
  const now = Date.now()
  const discoveredSet = new Set(discoveredIds)
  const absentIds: string[] = []

  await db.transaction('rw', db.searchListings, async () => {
    const existing = await db.searchListings.where('searchId').equals(searchId).toArray()

    for (const id of discoveredIds) {
      const rowId = searchListingId(searchId, id)
      const row = await db.searchListings.get(rowId)
      if (row) {
        await db.searchListings.update(rowId, {
          isPresent: true,
          lastSeenAt: now,
        })
      } else {
        await db.searchListings.add({
          id: rowId,
          searchId,
          listingId: id,
          firstSeenAt: now,
          lastSeenAt: now,
          isPresent: true,
        })
      }
    }

    for (const row of existing) {
      if (!discoveredSet.has(row.listingId) && row.isPresent) {
        await db.searchListings.update(row.id, { isPresent: false })
        absentIds.push(row.listingId)
      }
    }
  })

  if (runId && absentIds.length > 0) {
    const { markListingAbsentFromSearch } = await import('./scraper/upsert')
    for (const listingId of absentIds) {
      await markListingAbsentFromSearch(runId, listingId, searchId)
    }
  }

  return absentIds.length
}
