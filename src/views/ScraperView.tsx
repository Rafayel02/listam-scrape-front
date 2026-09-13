import { liveQuery } from 'dexie'
import { useEffect, useState } from 'react'
import { countListingsNeedingDetail, db, getRunCounters } from '../db'
import {
  formatNextDailyRun,
  getDailyScrapeStatus,
  runDailyScrapeBatch,
  subscribeDailyScrapeStatus,
} from '../scheduler/dailyScrape'
import { scrapeEngine } from '../scraper/engine'
import { DAILY_SCRAPE_ENABLED } from '../config'
import { hashAllCompleteListings } from '../scraper/hashListingImages'
import {
  getSyncState,
  isBackendConfigured,
  subscribeSync,
  syncAllToBackend,
} from '../sync/backendSync'
import type { RunCounters, SavedSearch, ScrapeLog, ScrapeRun } from '../types'
import { normalizeSearchUrl } from '../utils/url'

export function ScraperView() {
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [searches, setSearches] = useState<SavedSearch[]>([])
  const [runs, setRuns] = useState<ScrapeRun[]>([])
  const [activeRun, setActiveRun] = useState<ScrapeRun | null>(null)
  const [counters, setCounters] = useState<RunCounters | null>(null)
  const [logs, setLogs] = useState<ScrapeLog[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const [isPreparing, setIsPreparing] = useState(false)
  const [focusedRunId, setFocusedRunId] = useState<string | null>(null)
  const [detailNeedingCount, setDetailNeedingCount] = useState(0)
  const [ownerDetailNeedingCount, setOwnerDetailNeedingCount] = useState(0)
  const [syncState, setSyncState] = useState(getSyncState())
  const [syncing, setSyncing] = useState(false)
  const [hashing, setHashing] = useState(false)
  const [hashProgress, setHashProgress] = useState<string | null>(null)
  const [dailyScrapeStatus, setDailyScrapeStatus] = useState(getDailyScrapeStatus())
  const [dailyScrapeRunning, setDailyScrapeRunning] = useState(false)

  useEffect(() => {
    return subscribeSync(() => setSyncState(getSyncState()))
  }, [])

  useEffect(() => {
    return subscribeDailyScrapeStatus(() => setDailyScrapeStatus(getDailyScrapeStatus()))
  }, [])

  useEffect(() => {
    const sub1 = liveQuery(() => db.searches.orderBy('createdAt').reverse().toArray()).subscribe({
      next: (v) => setSearches(v),
    })
    const sub2 = liveQuery(() => db.scrapeRuns.orderBy('startedAt').reverse().toArray()).subscribe({
      next: (v) => setRuns(v),
    })
    return () => {
      sub1.unsubscribe()
      sub2.unsubscribe()
    }
  }, [])

  useEffect(() => {
    const runId = scrapeEngine.getActiveRunId() ?? focusedRunId
    const run =
      runs.find((r) => r.id === runId) ??
      runs.find((r) => r.status === 'running' && !r.awaitingUserReady) ??
      runs.find((r) => r.status === 'running' && r.awaitingUserReady) ??
      runs[0]
    setActiveRun(run ?? null)
  }, [runs, isRunning, isPreparing, focusedRunId])

  useEffect(() => {
    if (!activeRun) {
      setCounters(null)
      setLogs([])
      return
    }

    const sub1 = liveQuery(() => getRunCounters(activeRun.id)).subscribe({
      next: (v) => setCounters(v),
    })
    const sub2 = liveQuery(() =>
      db.scrapeLogs.where('runId').equals(activeRun.id).sortBy('timestamp'),
    ).subscribe({
      next: (v) => setLogs(v),
    })

    return () => {
      sub1.unsubscribe()
      sub2.unsubscribe()
    }
  }, [activeRun?.id])

  useEffect(() => {
    if (!activeRun) {
      setDetailNeedingCount(0)
      setOwnerDetailNeedingCount(0)
      return
    }
    const sub1 = liveQuery(() => countListingsNeedingDetail(activeRun.searchId)).subscribe({
      next: (v) => setDetailNeedingCount(v),
    })
    const sub2 = liveQuery(() =>
      countListingsNeedingDetail(activeRun.searchId, { onlyOwnerPosts: true }),
    ).subscribe({
      next: (v) => setOwnerDetailNeedingCount(v),
    })
    return () => {
      sub1.unsubscribe()
      sub2.unsubscribe()
    }
  }, [activeRun?.searchId])

  useEffect(() => {
    return scrapeEngine.subscribe(() => {
      setIsRunning(scrapeEngine.isRunning())
      setIsPreparing(scrapeEngine.isPreparing())
      db.scrapeRuns.orderBy('startedAt').reverse().toArray().then(setRuns)
    })
  }, [])

  async function createSearch() {
    setError(null)
    if (!url.trim()) {
      setError('URL is required')
      return
    }
    try {
      const cleaned = normalizeSearchUrl(url.trim())
      new URL(cleaned)
      const now = Date.now()
      await db.searches.add({
        id: crypto.randomUUID(),
        name: name.trim() || undefined,
        url: cleaned,
        createdAt: now,
        updatedAt: now,
      })
      setUrl('')
      setName('')
    } catch {
      setError('Invalid URL')
    }
  }

  async function startScrape(searchId: string) {
    setError(null)
    try {
      const runId = await scrapeEngine.startNewRun(searchId)
      setFocusedRunId(runId)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function resumeScrape(runId: string, onlyUnanalyzedDetails = false) {
    setError(null)
    try {
      const resumedId = await scrapeEngine.resumeRun(runId, { onlyUnanalyzedDetails })
      setFocusedRunId(resumedId)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function analyzeDetailsOnly(
    runId: string,
    options?: { onlyUnanalyzedDetails?: boolean; onlyOwnerPosts?: boolean },
  ) {
    setError(null)
    try {
      const startedId = await scrapeEngine.runDetailsOnly(runId, options)
      setFocusedRunId(startedId)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  function canRunDetailsOnly(run: ScrapeRun | undefined): boolean {
    if (!run) return false
    return ['interrupted', 'completed', 'cancelled'].includes(run.status)
  }

  function detailWorkCount(run: ScrapeRun | undefined, onlyOwnerPosts = false): number {
    const needing = onlyOwnerPosts ? ownerDetailNeedingCount : detailNeedingCount
    if (!run) return needing
    const queued = run.pendingDetailIds.length + run.processingDetailIds.length
    return Math.max(queued, needing)
  }

  async function stopScrape() {
    await scrapeEngine.stop()
  }

  async function hashImagesForDuplicates() {
    setError(null)
    setHashing(true)
    setHashProgress('Starting…')
    try {
      const result = await hashAllCompleteListings((current, total, listingId) => {
        setHashProgress(`Hashing ${current}/${total} — ${listingId}`)
      })
      setHashProgress(`Hashed ${result.hashed}/${result.processed} listings — syncing…`)
      await syncAllToBackend()
      setHashProgress(`Done — ${result.hashed} listings with hashes synced`)
    } catch (err) {
      setError((err as Error).message)
      setHashProgress(null)
    } finally {
      setHashing(false)
    }
  }

  async function pushToBackend() {
    setError(null)
    setSyncing(true)
    try {
      await syncAllToBackend()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSyncing(false)
    }
  }

  function interruptedRunForSearch(searchId: string): ScrapeRun | undefined {
    return runs.find((r) => r.searchId === searchId && r.status === 'interrupted')
  }

  function latestRunForSearch(searchId: string): ScrapeRun | undefined {
    return runs.find((r) => r.searchId === searchId)
  }

  async function runDailyScrapeNow() {
    setError(null)
    setDailyScrapeRunning(true)
    try {
      const result = await runDailyScrapeBatch()
      if (!result.started && result.reason) {
        setError(result.reason)
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setDailyScrapeRunning(false)
    }
  }

  return (
    <div className="view">
      <h2>Searches / Scraper</h2>

      <section className="panel">
        <h3>Daily auto-scrape (Yerevan)</h3>
        {!DAILY_SCRAPE_ENABLED ? (
          <p className="muted small">
            Disabled. Set <code>VITE_DAILY_SCRAPE_ENABLED=true</code> in <code>.env</code> to enable.
          </p>
        ) : (
          <>
            <p className="muted small">
              While this app is open, all saved searches run automatically once per Yerevan
              calendar day at midnight. Searches run in saved order. Skips if a scrape is already
              running.
            </p>
            <p className="muted small">
              Next run: <strong>{formatNextDailyRun()}</strong>
              {dailyScrapeStatus.lastRunDay && (
                <> · Last completed day: <strong>{dailyScrapeStatus.lastRunDay}</strong></>
              )}
              {dailyScrapeStatus.batchInProgress && <> · Batch in progress</>}
            </p>
            {dailyScrapeStatus.lastResult?.started && (
              <p className="muted small">
                Last batch: {dailyScrapeStatus.lastResult.completed} completed,{' '}
                {dailyScrapeStatus.lastResult.failed} failed of{' '}
                {dailyScrapeStatus.lastResult.total} searches
              </p>
            )}
            <div className="btn-group" style={{ marginTop: '0.5rem' }}>
              <button
                type="button"
                disabled={
                  dailyScrapeRunning ||
                  dailyScrapeStatus.batchInProgress ||
                  isRunning ||
                  isPreparing
                }
                onClick={() => void runDailyScrapeNow()}
              >
                {dailyScrapeRunning || dailyScrapeStatus.batchInProgress
                  ? 'Running daily batch…'
                  : 'Run all searches now'}
              </button>
            </div>
          </>
        )}
      </section>

      <section className="panel">
        <h3>Backend sync</h3>
        {!isBackendConfigured() ? (
          <p className="muted small">
            Set <code>VITE_API_URL</code> and <code>VITE_INGEST_API_KEY</code> in{' '}
            <code>.env</code> to push scraped data to Railway every 3 minutes.
          </p>
        ) : (
          <>
            <p className="muted small">
              Data syncs automatically every 3 minutes while this app is open, and again when a
              scrape completes. You can also push manually.
            </p>
            <p className="muted small">
              For duplicate-post detection in the visualizer, hash listing images here first
              (browser must be open), then push to backend.
            </p>
            <div className="btn-group" style={{ marginTop: '0.5rem' }}>
              <button
                type="button"
                disabled={hashing || syncing}
                onClick={() => void hashImagesForDuplicates()}
              >
                {hashing ? 'Hashing…' : 'Hash images for duplicates'}
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={syncing || hashing}
                onClick={() => void pushToBackend()}
              >
                {syncing ? 'Syncing…' : 'Push to backend'}
              </button>
              {syncState.lastSyncAt && (
                <span className="muted">
                  Last sync: {new Date(syncState.lastSyncAt).toLocaleString()}
                  {syncState.nextSyncAt && (
                    <> · Next: {new Date(syncState.nextSyncAt).toLocaleTimeString()}</>
                  )}
                </span>
              )}
            </div>
            {hashProgress && (
              <p className="muted small" style={{ marginTop: '0.5rem' }}>{hashProgress}</p>
            )}
            {syncState.lastCounts && (
              <p className="muted small" style={{ marginTop: '0.5rem' }}>
                {Object.entries(syncState.lastCounts)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(' · ')}
              </p>
            )}
          </>
        )}
      </section>

      <section className="panel">
        <h3>Create Search</h3>
        <div className="form-row">
          <input
            placeholder="List.am search URL"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <input
            placeholder="Optional name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button type="button" onClick={createSearch}>Create Search</button>
        </div>
        {error && <p className="error">{error}</p>}
      </section>

      <section className="panel">
        <h3>Saved Searches</h3>
        {searches.length === 0 && <p className="muted">No searches yet.</p>}
        <ul className="search-list">
          {searches.map((s) => {
            const interrupted = interruptedRunForSearch(s.id)
            const latest = latestRunForSearch(s.id)
            const isActive =
              activeRun?.searchId === s.id && (isRunning || isPreparing)
            const detailsOnlyRun = interrupted ?? latest
            const showDetailsOnly =
              canRunDetailsOnly(detailsOnlyRun) && !isActive && !!detailsOnlyRun
            return (
              <li key={s.id} className="search-item">
                <div>
                  <strong>{s.name || 'Unnamed search'}</strong>
                  <div className="muted small">{s.url}</div>
                  {latest && (
                    <div className="small">
                      Last run: {latest.status}
                      {latest.status === 'completed' && ' ✓'}
                    </div>
                  )}
                </div>
                <div className="btn-group">
                  <button
                    type="button"
                    disabled={isRunning || isPreparing}
                    onClick={() => startScrape(s.id)}
                  >
                    {latest ? 'Re-run' : 'Start'}
                  </button>
                  {interrupted && !isPreparing && (
                    <>
                      <button
                        type="button"
                        disabled={isRunning || isPreparing}
                        onClick={() => resumeScrape(interrupted.id)}
                      >
                        Resume
                      </button>
                      <button
                        type="button"
                        disabled={isRunning || isPreparing}
                        onClick={() => resumeScrape(interrupted.id, true)}
                        title="Re-scrape listings missing detail data or owner info"
                      >
                        Resume (unanalyzed only)
                      </button>
                    </>
                  )}
                  {showDetailsOnly && detailsOnlyRun && (
                    <>
                      <button
                        type="button"
                        disabled={isRunning || isPreparing}
                        onClick={() => analyzeDetailsOnly(detailsOnlyRun.id, { onlyUnanalyzedDetails: true })}
                        title="Fetch /item/ pages only — no search re-crawl"
                      >
                        Analyze details only
                      </button>
                      <button
                        type="button"
                        disabled={isRunning || isPreparing || ownerDetailNeedingCount === 0}
                        onClick={() =>
                          analyzeDetailsOnly(detailsOnlyRun.id, {
                            onlyUnanalyzedDetails: true,
                            onlyOwnerPosts: true,
                          })
                        }
                        title="Detail pages for likely private sellers only (skips brokers and agencies)"
                      >
                        Owner posts only ({ownerDetailNeedingCount})
                      </button>
                    </>
                  )}
                  {isActive && isRunning && (
                    <button type="button" onClick={stopScrape}>Stop</button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      </section>

      {activeRun && (
        <section className="panel">
          <h3>
            Status: {activeRun.status}
            {activeRun.status === 'completed' && ' — Done'}
            {activeRun.status === 'interrupted' && ' — Interrupted'}
          </h3>
          <div className="stats">
            <span>Page: {activeRun.currentPage}</span>
            <span>Discovered: {counters?.discovered ?? 0}</span>
            <span>Details: {counters?.detailsProcessed ?? 0}</span>
            <span>Created: {counters?.created ?? 0}</span>
            <span>Updated: {counters?.updated ?? 0}</span>
            <span>Unchanged: {counters?.unchanged ?? 0}</span>
            <span>Failed: {counters?.failed ?? 0}</span>
            <span>Pending details: {activeRun.pendingDetailIds.length}</span>
            <span>Processing: {activeRun.processingDetailIds.length}</span>
            <span>Need analysis: {detailNeedingCount}</span>
            <span>Owner posts: {ownerDetailNeedingCount}</span>
          </div>
          {canRunDetailsOnly(activeRun) &&
            !isRunning &&
            !isPreparing &&
            detailWorkCount(activeRun) > 0 && (
              <div className="btn-group" style={{ marginTop: '0.75rem' }}>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() =>
                    analyzeDetailsOnly(activeRun.id, { onlyUnanalyzedDetails: true })
                  }
                >
                  Analyze details only ({detailWorkCount(activeRun)})
                </button>
                {ownerDetailNeedingCount > 0 && (
                  <button
                    type="button"
                    onClick={() =>
                      analyzeDetailsOnly(activeRun.id, {
                        onlyUnanalyzedDetails: true,
                        onlyOwnerPosts: true,
                      })
                    }
                    title="Skip brokers and agencies — analyze likely private sellers only"
                  >
                    Owner posts only ({detailWorkCount(activeRun, true)})
                  </button>
                )}
              </div>
            )}
        </section>
      )}

      <section className="panel">
        <h3>Logs</h3>
        <div className="logs">
          {logs.length === 0 && <p className="muted">No logs yet.</p>}
          {logs.map((log) => (
            <div key={log.id} className={`log log-${log.level.toLowerCase()}`}>
              <span className="log-time">
                {new Date(log.timestamp).toLocaleTimeString()}
              </span>
              <span className="log-level">{log.level}</span>
              <span>{log.message}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
