import { db, runListingStatusId, searchListingId } from '../db'
import type {
  CardData,
  DetailData,
  EnrichmentStatus,
  Listing,
  ListingChange,
  Owner,
  OwnerData,
  RunListingStatus,
} from '../types'
import { diffListingFields } from '../utils/listingDiff'

function preserveEnrichmentStatus(existing?: Listing): EnrichmentStatus {
  if (!existing) return 'pending'
  return existing.enrichmentStatus
}

const CARD_FIELDS: (keyof Listing)[] = [
  'title',
  'price',
  'currency',
  'isMonthly',
  'thumbnailUrl',
  'street',
  'district',
  'rooms',
  'areaSqm',
  'currentFloor',
  'totalFloors',
  'badges',
  'verificationStatus',
  'cardExtras',
]

const DETAIL_FIELDS: (keyof Listing)[] = [
  'ownerId',
  'title',
  'description',
  'imageUrls',
  'attributes',
  'postedAt',
  'renewedAt',
  'sourcePriceHistory',
  'detailExtras',
]

const OWNER_FIELDS: (keyof Owner)[] = [
  'profileUrl',
  'name',
  'avatarUrl',
  'isVerifiedCompany',
  'rating',
  'reviewCount',
  'tenureText',
  'description',
  'reviewsUrl',
  'sitePostsCount',
  'scrapedPostsCount',
]

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null && b == null) return true
  return JSON.stringify(a) === JSON.stringify(b)
}

function mergeExtras(
  existing?: Record<string, unknown>,
  incoming?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!incoming && !existing) return undefined
  return { ...existing, ...incoming }
}

export interface UpsertCardResult {
  listingId: string
  existedBeforeRun: boolean
  provisionalStatus: RunListingStatus
  changes: ListingChange['changes']
}

export async function upsertCardData(
  runId: string,
  searchId: string,
  card: CardData,
): Promise<UpsertCardResult> {
  const now = Date.now()
  const existing = await db.listings.get(card.id)
  const existedBeforeRun = !!existing

  const relisted = !!existing?.isRemoved

  const merged: Partial<Listing> = {
    id: card.id,
    url: card.url,
    title: card.title,
    price: card.price,
    currency: card.currency,
    isMonthly: card.isMonthly,
    thumbnailUrl: card.thumbnailUrl,
    street: card.street,
    district: card.district,
    rooms: card.rooms,
    areaSqm: card.areaSqm,
    currentFloor: card.currentFloor,
    totalFloors: card.totalFloors,
    badges: card.badges,
    verificationStatus: card.verificationStatus,
    cardExtras: mergeExtras(existing?.cardExtras, card.cardExtras),
    enrichmentStatus: relisted ? 'pending' : preserveEnrichmentStatus(existing),
    isRemoved: relisted ? false : existing?.isRemoved,
    removedAt: relisted ? undefined : existing?.removedAt,
  }

  const cardDiffFields: (keyof Listing)[] = relisted
    ? [...CARD_FIELDS, 'isRemoved', 'removedAt', 'enrichmentStatus']
    : CARD_FIELDS

  const changes = existing ? diffListingFields(existing, merged, cardDiffFields) : []
  let provisionalStatus: RunListingStatus

  if (!existing) {
    provisionalStatus = 'CREATED'
    await db.listings.add({
      ...merged,
      id: card.id,
      url: card.url,
      firstSeenAt: now,
      lastSeenAt: now,
      lastChangedAt: now,
      enrichmentStatus: 'pending',
    } as Listing)
  } else {
    provisionalStatus = changes.length > 0 ? 'UPDATED' : 'UNCHANGED'
    await db.listings.update(card.id, {
      ...merged,
      lastSeenAt: now,
      lastChangedAt: changes.length > 0 ? now : existing.lastChangedAt,
    })
    if (changes.length > 0) {
      await db.listingChanges.add({
        listingId: card.id,
        scrapeRunId: runId,
        changedAt: now,
        changes,
      })
    }
  }

  const slId = searchListingId(searchId, card.id)
  const sl = await db.searchListings.get(slId)
  if (!sl) {
    await db.searchListings.add({
      id: slId,
      searchId,
      listingId: card.id,
      firstSeenAt: now,
      lastSeenAt: now,
      isPresent: true,
    })
  } else {
    await db.searchListings.update(slId, {
      lastSeenAt: now,
      isPresent: true,
    })
  }

  await db.runListingStatuses.put({
    id: runListingStatusId(runId, card.id),
    runId,
    listingId: card.id,
    status: provisionalStatus,
    existedBeforeRun,
  })

  return { listingId: card.id, existedBeforeRun, provisionalStatus, changes }
}

export interface UpsertDetailResult {
  changes: ListingChange['changes']
  statusUpgrade: boolean
  ownerId?: string
}

function diffOwnerFields(
  before: Partial<Owner>,
  after: Partial<Owner>,
): { field: string; from: unknown; to: unknown }[] {
  const changes: { field: string; from: unknown; to: unknown }[] = []
  for (const field of OWNER_FIELDS) {
    const from = before[field]
    const to = after[field]
    if (!valuesEqual(from, to)) {
      changes.push({ field, from, to })
    }
  }
  return changes
}

export async function upsertOwnerData(owner: OwnerData): Promise<{ ownerId: string; created: boolean }> {
  const now = Date.now()
  const existing = await db.owners.get(owner.id)
  const scrapedPostsCount = await db.listings.where('ownerId').equals(owner.id).count()

  const merged: Partial<Owner> = {
    id: owner.id,
    profileUrl: owner.profileUrl,
    name: owner.name,
    avatarUrl: owner.avatarUrl,
    isVerifiedCompany: owner.isVerifiedCompany,
    rating: owner.rating,
    reviewCount: owner.reviewCount,
    tenureText: owner.tenureText,
    description: owner.description,
    reviewsUrl: owner.reviewsUrl,
    sitePostsCount: owner.sitePostsCount ?? existing?.sitePostsCount,
    scrapedPostsCount,
  }

  if (!existing) {
    await db.owners.add({
      ...merged,
      id: owner.id,
      profileUrl: owner.profileUrl,
      firstSeenAt: now,
      lastSeenAt: now,
      lastChangedAt: now,
    } as Owner)
    return { ownerId: owner.id, created: true }
  }

  const changes = diffOwnerFields(existing, merged)
  await db.owners.update(owner.id, {
    ...merged,
    lastSeenAt: now,
    lastChangedAt: changes.length > 0 ? now : existing.lastChangedAt,
    ownerExtras: existing.ownerExtras,
  })

  return { ownerId: owner.id, created: false }
}

export async function upsertDetailData(
  runId: string,
  listingId: string,
  detail: DetailData,
): Promise<UpsertDetailResult> {
  const now = Date.now()
  const existing = await db.listings.get(listingId)
  if (!existing) {
    return { changes: [], statusUpgrade: false }
  }

  let ownerId = existing.ownerId
  if (detail.owner) {
    const ownerResult = await upsertOwnerData(detail.owner)
    ownerId = ownerResult.ownerId
  }

  const detailExtras: Record<string, unknown> = {
    ...(mergeExtras(existing.detailExtras, detail.detailExtras) ?? {}),
  }
  if (detail.location) detailExtras.location = detail.location
  if (detail.listingCode) detailExtras.listingCode = detail.listingCode
  if (detail.sellerType) detailExtras.sellerType = detail.sellerType
  if (detail.attributeSections) detailExtras.attributeSections = detail.attributeSections

  const merged: Partial<Listing> = {
    ownerId,
    title: detail.title ?? existing.title,
    description: detail.description ?? existing.description,
    imageUrls: detail.imageUrls ?? existing.imageUrls,
    attributes: detail.attributes ?? existing.attributes,
    sourcePriceHistory: detail.sourcePriceHistory ?? existing.sourcePriceHistory,
    postedAt: detail.postedAt ?? existing.postedAt,
    renewedAt: detail.renewedAt ?? existing.renewedAt,
    detailExtras: Object.keys(detailExtras).length ? detailExtras : undefined,
    enrichmentStatus: 'complete',
    enrichmentError: undefined,
  }

  const changes = diffListingFields(existing, merged, DETAIL_FIELDS)
  let statusUpgrade = false

  if (changes.length > 0) {
    await db.listings.update(listingId, {
      ...merged,
      lastChangedAt: now,
    })
    await db.listingChanges.add({
      listingId,
      scrapeRunId: runId,
      changedAt: now,
      changes,
    })

    const statusId = runListingStatusId(runId, listingId)
    const runStatus = await db.runListingStatuses.get(statusId)
    if (runStatus && runStatus.status === 'UNCHANGED' && runStatus.existedBeforeRun) {
      await db.runListingStatuses.update(statusId, { status: 'UPDATED' })
      statusUpgrade = true
    }
  } else {
    await db.listings.update(listingId, {
      ...merged,
      enrichmentStatus: 'complete',
      enrichmentError: undefined,
    })
  }

  if (ownerId) {
    const scrapedPostsCount = await db.listings.where('ownerId').equals(ownerId).count()
    await db.owners.update(ownerId, { scrapedPostsCount })
  }

  return { changes, statusUpgrade, ownerId }
}

export async function markListingFailed(listingId: string, error: string): Promise<void> {
  await db.listings.update(listingId, {
    enrichmentStatus: 'failed',
    enrichmentError: error,
  })
}

export async function markListingAbsentFromSearch(
  runId: string,
  listingId: string,
  searchId: string,
): Promise<void> {
  const existing = await db.listings.get(listingId)
  if (!existing || existing.isRemoved) return

  await markListingRemoved(runId, listingId, {
    searchId,
    message: 'No longer appears in search results',
  })
}

export async function markListingRemoved(
  runId: string,
  listingId: string,
  options?: { searchId?: string; message?: string },
): Promise<void> {
  const now = Date.now()
  const existing = await db.listings.get(listingId)
  if (!existing) return

  const detailExtras = mergeExtras(
    existing.detailExtras,
    options?.message ? { removedMessage: options.message } : undefined,
  )

  const merged: Partial<Listing> = {
    isRemoved: true,
    removedAt: now,
    enrichmentStatus: 'removed',
    enrichmentError: undefined,
    detailExtras,
  }

  const changes = diffListingFields(existing, merged, [
    'isRemoved',
    'removedAt',
    'enrichmentStatus',
    'detailExtras',
  ])

  await db.listings.update(listingId, {
    ...merged,
    lastChangedAt: changes.length > 0 ? now : existing.lastChangedAt,
  })

  if (changes.length > 0) {
    await db.listingChanges.add({
      listingId,
      scrapeRunId: runId,
      changedAt: now,
      changes,
    })
  }

  const searchRows = options?.searchId
    ? [await db.searchListings.get(searchListingId(options.searchId, listingId))].filter(Boolean)
    : await db.searchListings.where('listingId').equals(listingId).toArray()

  for (const row of searchRows) {
    if (row && row.isPresent) {
      await db.searchListings.update(row.id, { isPresent: false })
    }
  }
}

export async function setRunListingFailed(runId: string, listingId: string): Promise<void> {
  const statusId = runListingStatusId(runId, listingId)
  const existing = await db.runListingStatuses.get(statusId)
  if (existing) {
    await db.runListingStatuses.update(statusId, { status: 'FAILED' })
  } else {
    await db.runListingStatuses.put({
      id: statusId,
      runId,
      listingId,
      status: 'FAILED',
      existedBeforeRun: true,
    })
  }
}
