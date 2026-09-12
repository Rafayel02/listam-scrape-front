import { db } from '../db'
import type { IngestPayload } from '../types'

export interface SyncState {
  status: 'idle' | 'syncing' | 'ok' | 'error' | 'unconfigured'
  lastSyncAt?: number
  lastError?: string
  lastCounts?: Record<string, number>
}

type SyncListener = () => void

let state: SyncState = { status: 'idle' }
const listeners = new Set<SyncListener>()

function notify(): void {
  listeners.forEach((listener) => listener())
}

function apiConfig(): { url: string; key: string } | null {
  const url = import.meta.env.VITE_API_URL?.replace(/\/$/, '')
  const key = import.meta.env.VITE_INGEST_API_KEY
  if (!url || !key) return null
  return { url, key }
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

export async function syncAllToBackend(): Promise<Record<string, number>> {
  const config = apiConfig()
  if (!config) {
    throw new Error('Set VITE_API_URL and VITE_INGEST_API_KEY in .env')
  }

  state = { ...state, status: 'syncing', lastError: undefined }
  notify()

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

  const payload: IngestPayload = {
    searches,
    listings,
    owners,
    searchListings,
    scrapeRuns,
    runListingStatuses,
    scrapeLogs,
    listingChanges,
  }

  const res = await fetch(`${config.url}/api/ingest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': config.key,
    },
    body: JSON.stringify(payload),
  })

  if (!res.ok) {
    const text = await res.text()
    state = {
      status: 'error',
      lastError: text || `HTTP ${res.status}`,
      lastSyncAt: state.lastSyncAt,
      lastCounts: state.lastCounts,
    }
    notify()
    throw new Error(state.lastError)
  }

  const result = (await res.json()) as { counts: Record<string, number> }
  state = {
    status: 'ok',
    lastSyncAt: Date.now(),
    lastCounts: result.counts,
  }
  notify()
  return result.counts
}

export async function syncAfterRunComplete(): Promise<void> {
  if (!isBackendConfigured()) return
  try {
    await syncAllToBackend()
  } catch (err) {
    console.error('Backend sync failed:', err)
  }
}
