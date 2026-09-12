import {
  addLog,
  db,
  markInterruptedRuns,
  releaseAllProcessingJobs,
  setAwaitingUserReady,
  setRunStatus,
  skipAlreadyAnalyzedDetails,
  skipNonOwnerPostsFromDetailQueue,
  syncDetailQueueFromListings,
  updatePresenceAfterSuccessfulCrawl,
} from '../db'
import {
  beginBrowserScraping,
  closeScrapeBrowser,
  prepareBrowser,
} from '../network/fetchHtml'
import type { SavedSearch, ScrapeRun } from '../types'
import { getStartPage } from '../utils/url'
import { syncAfterRunComplete } from '../sync/backendSync'
import { runCardCrawler } from './cardCrawler'
import { runDetailEnricher } from './detailEnricher'

type EngineListener = () => void

export interface ResumeOptions {
  /** Skip detail fetches for listings already marked complete in the DB. */
  onlyUnanalyzedDetails?: boolean
  /** Only analyze listings from likely private sellers (skip brokers/agencies). */
  onlyOwnerPosts?: boolean
}

interface RunWorkerOptions {
  skipCardCrawler?: boolean
  onlyOwnerPosts?: boolean
}

class ScrapeEngine {
  private abortController: AbortController | null = null
  private activeRunId: string | null = null
  private preparingRunId: string | null = null
  private workerPromise: Promise<void> | null = null
  private queuedDetailIds = new Set<string>()
  private listeners = new Set<EngineListener>()

  subscribe(listener: EngineListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    this.listeners.forEach((l) => l())
  }

  async init(): Promise<void> {
    await markInterruptedRuns()
  }

  getActiveRunId(): string | null {
    return this.activeRunId ?? this.preparingRunId
  }

  getPreparingRunId(): string | null {
    return this.preparingRunId
  }

  isRunning(): boolean {
    return this.abortController !== null
  }

  isPreparing(): boolean {
    return this.preparingRunId !== null
  }

  async startNewRun(searchId: string): Promise<string> {
    if (this.isRunning() || this.isPreparing()) {
      throw new Error('A scrape is already in progress')
    }

    const search = await db.searches.get(searchId)
    if (!search) throw new Error('Search not found')

    const runId = crypto.randomUUID()
    const startPage = getStartPage(search.url)

    const run: ScrapeRun = {
      id: runId,
      searchId,
      status: 'running',
      startedAt: Date.now(),
      lastCompletedPage: 0,
      currentPage: startPage,
      searchPagesComplete: false,
      pendingDetailIds: [],
      processingDetailIds: [],
      completedDetailIds: [],
      failedDetailIds: [],
      discoveredListingIds: [],
      detailRetryCounts: {},
      awaitingUserReady: true,
      refreshDetails: true,
    }

    await db.scrapeRuns.add(run)
    this.preparingRunId = runId

    try {
      await prepareBrowser(search.url)
      await addLog(
        runId,
        'INFO',
        'Browser open — check list.am looks correct, then click Begin Scraping',
      )
      this.notify()
      return runId
    } catch (err) {
      await setRunStatus(runId, 'interrupted')
      await setAwaitingUserReady(runId, false)
      this.preparingRunId = null
      await addLog(runId, 'ERROR', `Failed to open browser: ${(err as Error).message}`)
      this.notify()
      throw err
    }
  }

  async beginScraping(runId: string): Promise<void> {
    const run = await db.scrapeRuns.get(runId)
    if (!run) throw new Error('Run not found')
    if (!run.awaitingUserReady) {
      throw new Error('This run is not waiting to begin')
    }

    const search = await db.searches.get(run.searchId)
    if (!search) throw new Error('Search not found')

    await setAwaitingUserReady(runId, false)

    try {
      await beginBrowserScraping()
      await addLog(
        runId,
        'INFO',
        'Starting scrape — crawl filter, refresh listing details, mark missing posts as removed',
      )

      this.activeRunId = runId
      this.preparingRunId = null
      this.abortController = new AbortController()
      this.notify()

      this.workerPromise = this.runWorkers(run, search).finally(() => {
        this.workerPromise = null
      })
    } catch (err) {
      this.preparingRunId = null
      this.activeRunId = null
      this.abortController = null
      this.workerPromise = null
      await setRunStatus(runId, 'interrupted')
      await addLog(runId, 'ERROR', `Failed to begin scrape: ${(err as Error).message}`)
      this.notify()
      throw err
    }
  }

  async resumeRun(runId: string, options?: ResumeOptions): Promise<string> {
    if (this.isRunning() || this.isPreparing()) {
      throw new Error('A scrape is already in progress')
    }

    const run = await db.scrapeRuns.get(runId)
    if (!run) throw new Error('Run not found')
    if (run.status !== 'interrupted') {
      throw new Error('Run is not resumable')
    }

    const search = await db.searches.get(run.searchId)
    if (!search) throw new Error('Search not found')

    const neverStartedCrawling =
      run.lastCompletedPage === 0 &&
      !run.searchPagesComplete &&
      run.discoveredListingIds.length === 0

    if (run.awaitingUserReady || neverStartedCrawling) {
      await setRunStatus(runId, 'running')
      await setAwaitingUserReady(runId, true)
      this.preparingRunId = runId

      try {
        await prepareBrowser(search.url)
        await addLog(
          runId,
          'INFO',
          'Browser open — check list.am looks correct, then click Begin Scraping',
        )
        this.notify()
        return runId
      } catch (err) {
        await setRunStatus(runId, 'interrupted')
        this.preparingRunId = null
        throw err
      }
    }

    await setRunStatus(runId, 'running')

    if (options?.onlyUnanalyzedDetails) {
      const skipped = await skipAlreadyAnalyzedDetails(runId)
      await addLog(
        runId,
        'INFO',
        `Resuming — only unanalyzed details (${skipped} fully-analyzed skipped, missing-owner will re-run)`,
      )
    } else {
      await addLog(runId, 'INFO', 'Resuming scrape')
    }

    if (options?.onlyOwnerPosts) {
      const skippedBrokers = await skipNonOwnerPostsFromDetailQueue(runId)
      await addLog(
        runId,
        'INFO',
        `Owner-only mode — ${skippedBrokers} broker/agency listing${skippedBrokers === 1 ? '' : 's'} skipped`,
      )
    }

    try {
      await prepareBrowser(search.url)
      await beginBrowserScraping()
    } catch (err) {
      await setRunStatus(runId, 'interrupted')
      throw err
    }

    const freshRun = (await db.scrapeRuns.get(runId)) ?? run
    const skipCardCrawler =
      options?.onlyUnanalyzedDetails === true && freshRun.searchPagesComplete

    this.queuedDetailIds = new Set([
      ...freshRun.pendingDetailIds,
      ...freshRun.processingDetailIds,
      ...freshRun.completedDetailIds,
      ...freshRun.failedDetailIds,
    ])

    this.workerPromise = this.runWorkers(freshRun, search, {
      skipCardCrawler,
      onlyOwnerPosts: options?.onlyOwnerPosts,
    }).finally(() => {
      this.workerPromise = null
    })
    this.notify()
    return runId
  }

  async runDetailsOnly(runId: string, options?: ResumeOptions): Promise<string> {
    if (this.isRunning() || this.isPreparing()) {
      throw new Error('A scrape is already in progress')
    }

    const run = await db.scrapeRuns.get(runId)
    if (!run) throw new Error('Run not found')

    const allowedStatuses = new Set(['interrupted', 'completed', 'cancelled'])
    if (!allowedStatuses.has(run.status)) {
      throw new Error('Details-only run is not available for this run status')
    }

    const search = await db.searches.get(run.searchId)
    if (!search) throw new Error('Search not found')

    await releaseAllProcessingJobs(runId)
    const synced = await syncDetailQueueFromListings(runId, run.searchId, {
      onlyOwnerPosts: options?.onlyOwnerPosts,
    })

    if (options?.onlyUnanalyzedDetails) {
      await skipAlreadyAnalyzedDetails(runId)
    }

    let skippedBrokers = 0
    if (options?.onlyOwnerPosts) {
      skippedBrokers = await skipNonOwnerPostsFromDetailQueue(runId)
    }

    const freshRun = await db.scrapeRuns.get(runId)
    const queued =
      (freshRun?.pendingDetailIds.length ?? 0) + (freshRun?.processingDetailIds.length ?? 0)
    if (queued === 0) {
      throw new Error(
        options?.onlyOwnerPosts
          ? 'No owner listings need detail analysis'
          : 'No listings need detail analysis',
      )
    }

    await setRunStatus(runId, 'running')

    try {
      await prepareBrowser(search.url)
      await beginBrowserScraping()
    } catch (err) {
      await setRunStatus(runId, 'interrupted')
      throw err
    }

    const updatedRun = (await db.scrapeRuns.get(runId)) ?? run
    const ownerOnlyNote = options?.onlyOwnerPosts
      ? `, owner posts only${skippedBrokers ? `, ${skippedBrokers} broker/agency skipped` : ''}`
      : ''
    await addLog(
      runId,
      'INFO',
      `Starting details-only pass (${updatedRun.pendingDetailIds.length} queued${synced ? `, ${synced} synced from listings` : ''}${ownerOnlyNote})`,
    )

    this.queuedDetailIds = new Set([
      ...updatedRun.pendingDetailIds,
      ...updatedRun.processingDetailIds,
      ...updatedRun.completedDetailIds,
      ...updatedRun.failedDetailIds,
    ])

    this.workerPromise = this.runWorkers(updatedRun, search, {
      skipCardCrawler: true,
      onlyOwnerPosts: options?.onlyOwnerPosts,
    }).finally(() => {
      this.workerPromise = null
    })
    this.notify()
    return runId
  }

  private async runWorkers(
    run: ScrapeRun,
    search: SavedSearch,
    options?: RunWorkerOptions,
  ): Promise<void> {
    this.activeRunId = run.id
    this.abortController = new AbortController()
    this.queuedDetailIds = new Set([
      ...run.pendingDetailIds,
      ...run.processingDetailIds,
      ...run.completedDetailIds,
      ...run.failedDetailIds,
    ])

    const signal = this.abortController.signal

    const isDoneGateReady = async (): Promise<boolean> => {
      const current = await db.scrapeRuns.get(run.id)
      if (!current) return false
      return (
        current.searchPagesComplete &&
        current.pendingDetailIds.length === 0 &&
        current.processingDetailIds.length === 0
      )
    }

    const tryComplete = async (): Promise<void> => {
      const current = await db.scrapeRuns.get(run.id)
      if (!current || current.status !== 'running') return

      if (
        current.searchPagesComplete &&
        current.pendingDetailIds.length === 0 &&
        current.processingDetailIds.length === 0
      ) {
        const absentCount = await updatePresenceAfterSuccessfulCrawl(
          current.searchId,
          current.discoveredListingIds,
          current.id,
        )
        if (absentCount > 0) {
          await addLog(
            run.id,
            'INFO',
            `Marked ${absentCount} listing${absentCount === 1 ? '' : 's'} absent from search (soft-deleted, data kept)`,
          )
        }
        await setRunStatus(run.id, 'completed', Date.now())
        await addLog(run.id, 'INFO', 'Done')
        void syncAfterRunComplete()
        this.notify()
      }
    }

    const onStateChange = () => {
      this.notify()
      void tryComplete()
    }

    const detailPromise = runDetailEnricher({
      runId: run.id,
      signal,
      onStateChange,
      isDoneGateReady,
      onlyOwnerPosts: options?.onlyOwnerPosts,
    })

    if (options?.skipCardCrawler) {
      await addLog(run.id, 'INFO', 'Search pages already complete — detail enricher only')
      await detailPromise
    } else {
      const cardPromise = runCardCrawler({
        run,
        search,
        signal,
        queuedDetailIds: this.queuedDetailIds,
        onStateChange,
      }).catch(async (err) => {
        if ((err as Error).name === 'AbortError') return
        const current = await db.scrapeRuns.get(run.id)
        if (current?.status === 'running') {
          await releaseAllProcessingJobs(run.id)
          await setRunStatus(run.id, 'interrupted')
          await addLog(run.id, 'ERROR', `Card crawler stopped: ${(err as Error).message}`)
        }
        this.notify()
      })

      await Promise.allSettled([cardPromise, detailPromise])
    }
    await tryComplete()
    await closeScrapeBrowser()
    this.abortController = null
    this.activeRunId = null
    this.notify()
  }

  async stop(): Promise<void> {
    const runId = this.activeRunId ?? this.preparingRunId
    if (!runId) return

    if (this.abortController) {
      this.abortController.abort()
    }

    if (this.workerPromise) {
      await this.workerPromise.catch(() => {})
    }

    await releaseAllProcessingJobs(runId)
    await setRunStatus(runId, 'cancelled', Date.now())
    await setAwaitingUserReady(runId, false)
    await addLog(runId, 'INFO', 'Scrape cancelled')
    await closeScrapeBrowser()

    this.abortController = null
    this.activeRunId = null
    this.preparingRunId = null
    this.workerPromise = null
    this.notify()
  }
}

export const scrapeEngine = new ScrapeEngine()
