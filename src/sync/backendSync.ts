import {
  BACKEND_SYNC_INTERVAL_MS,
  INGEST_MAX_BATCH_BYTES,
} from '../config'
import { db } from '../db'
import type { IngestPayload } from '../types'

export interface SyncState {
  status: 'idle' | 'syncing' | 'ok' | 'error' | 'unconfigured'
  lastSyncAt?: number
  lastError?: string
  lastCounts?: Record<string, number>
  nextSyncAt?: number
  progress?: string
}

type SyncListener = () => void

type IngestCollection = keyof IngestPayload

const INGEST_COLLECTIONS: IngestCollection[] = [
  'searches',
  'owners',
  'listings',
  'searchListings',
  'scrapeRuns',
  'runListingStatuses',
  'scrapeLogs',
  'listingChanges',
]

let state: SyncState = { status: 'idle' }
const listeners = new Set<SyncListener>()
let syncInProgress = false
let periodicTimer: ReturnType<typeof setInterval> | null = null

function notify(): void {
  listeners.forEach((listener) => listener())
}

function apiConfig(): { url: string; key: string } | null {
  const url = import.meta.env.VITE_API_URL?.replace(/\/$/, '')
  const key = import.meta.env.VITE_INGEST_API_KEY
  if (!url || !key) return null
  return { url, key }
}

function scheduleNextSyncAt(): void {
  if (!isBackendConfigured()) {
    state = { ...state, nextSyncAt: undefined }
    return
  }
  state = { ...state, nextSyncAt: Date.now() + BACKEND_SYNC_INTERVAL_MS }
}

export function isBackendConfigured(): boolean {
  return apiConfig() !== null
}

export function getSyncState(): SyncState {
  if (!isBackendConfigured()) return { status: 'unconfigured' }
  return state
}

export function subscribeSync(listener: SyncListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function setProgress(progress: string): void {
  state = { ...state, status: 'syncing', progress }
  notify()
}

function formatIngestError(status: number, text: string): string {
  const plain = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  if (status === 413 || /payload too large/i.test(plain)) {
    return 'Payload Too Large'
  }
  return plain || `HTTP ${status}`
}

function isPayloadTooLarge(status: number, text: string): boolean {
  return status === 413 || /payload too large/i.test(text)
}

function chunkByJsonSize<T>(items: T[], maxBytes: number): T[][] {
  if (items.length === 0) return []

  const batches: T[][] = []
  let current: T[] = []
  let currentBytes = 2 // []

  const flush = (): void => {
    if (current.length === 0) return
    batches.push(current)
    current = []
    currentBytes = 2
  }

  for (const item of items) {
    const encoded = JSON.stringify(item)

    if (current.length === 0 && encoded.length + 2 > maxBytes) {
      batches.push([item])
      continue
    }

    const addBytes = encoded.length + (current.length > 0 ? 1 : 0)
    if (current.length > 0 && currentBytes + addBytes > maxBytes) {
      flush()
    }

    current.push(item)
    currentBytes += encoded.length + (current.length > 1 ? 1 : 0)
  }

  flush()
  return batches
}

function mergeCounts(
  into: Record<string, number>,
  from: Record<string, number> | undefined,
): void {
  if (!from) return
  for (const [key, value] of Object.entries(from)) {
    if (typeof value === 'number') {
      into[key] = (into[key] ?? 0) + value
    }
  }
}

async function postIngestBatch(
  config: { url: string; key: string },
  payload: IngestPayload,
): Promise<Record<string, number>> {
  const res = await fetch(`${config.url}/api/ingest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': config.key,
    },
    body: JSON.stringify(payload),
  })

  const text = await res.text()
  if (!res.ok) {
    const err = new Error(formatIngestError(res.status, text)) as Error & {
      status?: number
      payloadTooLarge?: boolean
    }
    err.status = res.status
    err.payloadTooLarge = isPayloadTooLarge(res.status, text)
    throw err
  }

  if (!text) return {}
  try {
    const result = JSON.parse(text) as { counts?: Record<string, number> }
    return result.counts ?? {}
  } catch {
    return {}
  }
}

async function postCollectionBatches(
  config: { url: string; key: string },
  collection: IngestCollection,
  items: unknown[],
  maxBytes: number,
  totals: Record<string, number>,
): Promise<void> {
  if (items.length === 0) return

  const queue = chunkByJsonSize(items, maxBytes)
  let uploaded = 0

  while (queue.length > 0) {
    const batch = queue.shift()!
    setProgress(
      `Uploading ${collection}: ${Math.min(uploaded + batch.length, items.length)}/${items.length}`,
    )

    try {
      const counts = await postIngestBatch(config, { [collection]: batch })
      mergeCounts(totals, counts)
      uploaded += batch.length
    } catch (err) {
      const error = err as Error & { payloadTooLarge?: boolean }
      if (error.payloadTooLarge && batch.length > 1) {
        const mid = Math.ceil(batch.length / 2)
        queue.unshift(batch.slice(0, mid), batch.slice(mid))
        continue
      }
      throw err
    }
  }
}

export async function syncAllToBackend(): Promise<Record<string, number>> {
  const config = apiConfig()
  if (!config) {
    throw new Error('Set VITE_API_URL and VITE_INGEST_API_KEY in .env')
  }

  if (syncInProgress) {
    throw new Error('Sync already in progress')
  }

  syncInProgress = true
  state = {
    ...state,
    status: 'syncing',
    lastError: undefined,
    progress: 'Loading local data…',
  }
  notify()

  try {
    const [
      searches,
      listings,
      owners,
      searchListings,
      scrapeRuns,
      runListingStatuses,
      scrapeLogs,
      listingChanges,
    ] = await Promise.all([
      db.searches.toArray(),
      db.listings.toArray(),
      db.owners.toArray(),
      db.searchListings.toArray(),
      db.scrapeRuns.toArray(),
      db.runListingStatuses.toArray(),
      db.scrapeLogs.toArray(),
      db.listingChanges.toArray(),
    ])

    const data: Record<IngestCollection, unknown[]> = {
      searches,
      owners,
      listings,
      searchListings,
      scrapeRuns,
      runListingStatuses,
      scrapeLogs,
      listingChanges,
    }

    const totals: Record<string, number> = {}
    for (const collection of INGEST_COLLECTIONS) {
      await postCollectionBatches(
        config,
        collection,
        data[collection],
        INGEST_MAX_BATCH_BYTES,
        totals,
      )
    }

    state = {
      status: 'ok',
      lastSyncAt: Date.now(),
      lastCounts: totals,
      progress: undefined,
    }
    scheduleNextSyncAt()
    notify()
    return totals
  } catch (err) {
    const message = (err as Error).message
    state = {
      status: 'error',
      lastError: message,
      lastSyncAt: state.lastSyncAt,
      lastCounts: state.lastCounts,
      progress: undefined,
    }
    scheduleNextSyncAt()
    notify()
    throw err
  } finally {
    syncInProgress = false
  }
}

async function syncInBackground(): Promise<void> {
  if (!isBackendConfigured() || syncInProgress) return
  try {
    await syncAllToBackend()
  } catch (err) {
    console.error('Backend sync failed:', err)
  }
}

export function startPeriodicBackendSync(): void {
  if (!isBackendConfigured() || periodicTimer) return

  scheduleNextSyncAt()
  notify()

  void syncInBackground()

  periodicTimer = setInterval(() => {
    void syncInBackground()
  }, BACKEND_SYNC_INTERVAL_MS)
}

export function stopPeriodicBackendSync(): void {
  if (periodicTimer) {
    clearInterval(periodicTimer)
    periodicTimer = null
  }
  state = { ...state, nextSyncAt: undefined }
  notify()
}

export async function syncAfterRunComplete(): Promise<void> {
  await syncInBackground()
}
