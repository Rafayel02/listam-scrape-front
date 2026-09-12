import { db } from '../db'
import { parseDetailPage } from '../parsers/detailPage'
import type { DetailData } from '../types'
import { enrichOwnerWithProfileData } from './enrichOwner'
import { markListingFailed, markListingRemoved, upsertDetailData } from './upsert'

export const MANUAL_SCRAPE_RUN_ID = 'manual-scrape'

export interface ScrapeItemResult {
  detail: DetailData
  changeCount: number
}

export async function scrapeListingItem(listingId: string): Promise<ScrapeItemResult> {
  const listing = await db.listings.get(listingId)
  if (!listing) {
    throw new Error('Listing not found in database')
  }

  await db.listings.update(listingId, {
    enrichmentStatus: 'processing',
    enrichmentError: undefined,
  })

  try {
    const res = await fetch('/api/dev/scrape-item', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ listingId }),
    })

    const data = (await res.json()) as
      | { ok: true; html: string; finalUrl?: string }
      | { ok: false; retry?: boolean; message?: string }

    if (!data.ok || !('html' in data) || !data.html) {
      const message = 'message' in data ? data.message : 'Scrape failed'
      throw new Error(message ?? 'Scrape failed')
    }

    let detail = parseDetailPage(data.html)

    if (detail.owner) {
      detail.owner = await enrichOwnerWithProfileData(
        detail.owner,
        new AbortController().signal,
      )
    }

    if (detail.removed) {
      await markListingRemoved(MANUAL_SCRAPE_RUN_ID, listingId, {
        message: detail.removedMessage,
      })
      return {
        detail,
        changeCount: 0,
      }
    }

    const result = await upsertDetailData(MANUAL_SCRAPE_RUN_ID, listingId, detail)

    return {
      detail,
      changeCount: result.changes.length,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Scrape failed'
    await markListingFailed(listingId, message)
    throw err
  }
}
