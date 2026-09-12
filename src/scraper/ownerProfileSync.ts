import { OWNER_PROFILE_JOB_DELAY_MS } from '../config'
import { db } from '../db'
import { fetchHtmlWithMeta } from '../network/fetchHtml'
import {
  getOwnerProfileFetchError,
  isOwnerProfilePage,
  parseOwnerProfilePage,
} from '../parsers/ownerProfile'
import type { Owner } from '../types'

export interface OwnerProfileSyncResult {
  ownerId: string
  updated: boolean
  sitePostsCount?: number
  error?: string
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

export async function saveOwnerProfileData(
  ownerId: string,
  profile: ReturnType<typeof parseOwnerProfilePage>,
): Promise<boolean> {
  const now = Date.now()
  const existing = await db.owners.get(ownerId)
  const scrapedPostsCount = await db.listings.where('ownerId').equals(ownerId).count()

  const next: Partial<Owner> = {
    sitePostsCount: profile.sitePostsCount ?? existing?.sitePostsCount,
    name: profile.name ?? existing?.name,
    avatarUrl: profile.avatarUrl ?? existing?.avatarUrl,
    isVerifiedCompany: profile.isVerifiedCompany ?? existing?.isVerifiedCompany,
    rating: profile.rating ?? existing?.rating,
    reviewCount: profile.reviewCount ?? existing?.reviewCount,
    tenureText: profile.tenureText ?? existing?.tenureText,
    description: profile.description ?? existing?.description,
    scrapedPostsCount,
  }

  const changed =
    existing?.sitePostsCount !== next.sitePostsCount ||
    existing?.name !== next.name ||
    existing?.rating !== next.rating ||
    existing?.reviewCount !== next.reviewCount

  if (!existing) {
    await db.owners.add({
      id: ownerId,
      profileUrl: `/user/${ownerId}`,
      firstSeenAt: now,
      lastSeenAt: now,
      lastChangedAt: now,
      scrapedPostsCount,
      ...next,
    } as Owner)
    return profile.sitePostsCount != null
  }

  await db.owners.update(ownerId, {
    ...next,
    lastSeenAt: now,
    lastChangedAt: changed ? now : existing.lastChangedAt,
    ownerExtras: existing.ownerExtras,
  })

  return changed
}

export async function fetchAndSaveOwnerProfile(
  ownerId: string,
  signal: AbortSignal,
): Promise<OwnerProfileSyncResult> {
  try {
    const { html, finalUrl } = await fetchHtmlWithMeta(
      `/user/${ownerId}`,
      signal,
      undefined,
      { dedicatedPage: true },
    )

    if (!isOwnerProfilePage(html)) {
      return {
        ownerId,
        updated: false,
        error: getOwnerProfileFetchError(html, finalUrl, ownerId),
      }
    }

    const profile = parseOwnerProfilePage(html)
    const updated = await saveOwnerProfileData(ownerId, profile)

    if (profile.sitePostsCount == null) {
      return {
        ownerId,
        updated: false,
        error: getOwnerProfileFetchError(html, finalUrl, ownerId),
      }
    }

    return {
      ownerId,
      updated,
      sitePostsCount: profile.sitePostsCount,
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err
    return {
      ownerId,
      updated: false,
      error: err instanceof Error ? err.message : 'Profile fetch failed',
    }
  }
}

export interface SyncOwnerProfilesOptions {
  onlyMissing?: boolean
  signal: AbortSignal
  onProgress?: (progress: {
    total: number
    done: number
    updated: number
    failed: number
    currentOwnerId?: string
  }) => void
  onLog?: (message: string, level: 'INFO' | 'WARN' | 'ERROR') => void
}

export async function syncOwnerProfilesFromSite(
  options: SyncOwnerProfilesOptions,
): Promise<{ updated: number; failed: number }> {
  const { onlyMissing = true, signal, onProgress, onLog } = options

  const owners = await db.owners.orderBy('lastSeenAt').reverse().toArray()
  const ownerIds = owners
    .filter((owner) => !onlyMissing || owner.sitePostsCount == null)
    .map((owner) => owner.id)

  const listingOwnerIds = [
    ...new Set(
      (await db.listings.toArray())
        .map((listing) => listing.ownerId)
        .filter((id): id is string => !!id),
    ),
  ]

  const allIds = [...new Set([...ownerIds, ...listingOwnerIds])]

  let done = 0
  let updated = 0
  let failed = 0

  const report = (currentOwnerId?: string) => {
    onProgress?.({
      total: allIds.length,
      done,
      updated,
      failed,
      currentOwnerId,
    })
  }

  report()

  for (const ownerId of allIds) {
    if (signal.aborted) break

    report(ownerId)
    onLog?.(`Fetching profile /user/${ownerId}`, 'INFO')

    const result = await fetchAndSaveOwnerProfile(ownerId, signal)

    if (result.error) {
      failed++
      onLog?.(`Owner ${ownerId}: ${result.error}`, 'WARN')
    } else if (result.updated) {
      updated++
      onLog?.(
        `Owner ${ownerId}: ${result.sitePostsCount} posts on list.am`,
        'INFO',
      )
    } else {
      onLog?.(`Owner ${ownerId}: unchanged (${result.sitePostsCount ?? '—'} posts)`, 'INFO')
    }

    done++
    report()

    if (OWNER_PROFILE_JOB_DELAY_MS > 0 && !signal.aborted && done < allIds.length) {
      await delay(OWNER_PROFILE_JOB_DELAY_MS, signal)
    }
  }

  return { updated, failed }
}
