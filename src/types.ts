export type EnrichmentStatus = 'pending' | 'processing' | 'complete' | 'failed' | 'removed'
export type RunListingStatus = 'CREATED' | 'UPDATED' | 'UNCHANGED' | 'FAILED'
export type ScrapeRunStatus = 'running' | 'interrupted' | 'completed' | 'cancelled'
export type LogLevel = 'INFO' | 'WARN' | 'ERROR'

export interface SavedSearch {
  id: string
  name?: string
  url: string
  createdAt: number
  updatedAt: number
}

export interface PriceHistoryEntry {
  date?: string
  price?: number
  currency?: string
  raw?: string
}

export interface Owner {
  id: string
  profileUrl: string
  name?: string
  avatarUrl?: string
  isVerifiedCompany?: boolean
  rating?: number
  reviewCount?: number
  tenureText?: string
  description?: string
  reviewsUrl?: string
  /** Active listings on list.am (from seller profile). */
  sitePostsCount?: number
  /** Listings linked to this owner in local DB. */
  scrapedPostsCount?: number
  ownerExtras?: Record<string, unknown>
  firstSeenAt: number
  lastSeenAt: number
  lastChangedAt: number
}

export interface Listing {
  id: string
  url: string
  ownerId?: string
  title?: string
  price?: number
  currency?: string
  isMonthly?: boolean
  thumbnailUrl?: string
  street?: string
  district?: string
  rooms?: number
  areaSqm?: number
  currentFloor?: number
  totalFloors?: number
  badges?: string[]
  verificationStatus?: string
  description?: string
  imageUrls?: string[]
  attributes?: Record<string, string>
  sourcePriceHistory?: PriceHistoryEntry[]
  postedAt?: number
  renewedAt?: number
  firstSeenAt: number
  lastSeenAt: number
  lastChangedAt: number
  enrichmentStatus: EnrichmentStatus
  enrichmentError?: string
  isRemoved?: boolean
  removedAt?: number
  cardExtras?: Record<string, unknown>
  detailExtras?: Record<string, unknown>
}

export interface SearchListing {
  id: string
  searchId: string
  listingId: string
  firstSeenAt: number
  lastSeenAt: number
  isPresent: boolean
}

export interface ScrapeRun {
  id: string
  searchId: string
  status: ScrapeRunStatus
  startedAt: number
  finishedAt?: number
  lastCompletedPage: number
  currentPage: number
  searchPagesComplete: boolean
  pendingDetailIds: string[]
  processingDetailIds: string[]
  completedDetailIds: string[]
  failedDetailIds: string[]
  discoveredListingIds: string[]
  detailRetryCounts: Record<string, number>
  awaitingUserReady: boolean
  /** Re-fetch /item/ pages for listings already analyzed (full Re-run). */
  refreshDetails?: boolean
}

export interface RunListingStatusRecord {
  id: string
  runId: string
  listingId: string
  status: RunListingStatus
  existedBeforeRun: boolean
}

export interface ScrapeLog {
  id?: number
  runId: string
  timestamp: number
  level: LogLevel
  message: string
}

export interface ListingChange {
  id?: number
  listingId: string
  scrapeRunId: string
  changedAt: number
  changes: { field: string; from: unknown; to: unknown }[]
}

export interface CardData {
  id: string
  url: string
  title?: string
  price?: number
  currency?: string
  isMonthly?: boolean
  thumbnailUrl?: string
  street?: string
  district?: string
  rooms?: number
  areaSqm?: number
  currentFloor?: number
  totalFloors?: number
  badges?: string[]
  verificationStatus?: string
  cardExtras?: Record<string, unknown>
}

export interface OwnerData {
  id: string
  profileUrl: string
  name?: string
  avatarUrl?: string
  isVerifiedCompany?: boolean
  rating?: number
  reviewCount?: number
  tenureText?: string
  description?: string
  reviewsUrl?: string
  sitePostsCount?: number
}

export interface DetailData {
  title?: string
  location?: string
  listingCode?: string
  sellerType?: string
  description?: string
  imageUrls?: string[]
  attributes?: Record<string, string>
  attributeSections?: Record<string, Record<string, string>>
  sourcePriceHistory?: PriceHistoryEntry[]
  postedAt?: number
  renewedAt?: number
  owner?: OwnerData
  removed?: boolean
  removedMessage?: string
  detailExtras?: Record<string, unknown>
}

export interface RunCounters {
  created: number
  updated: number
  unchanged: number
  failed: number
  discovered: number
  detailsProcessed: number
}

export interface IngestPayload {
  searches?: SavedSearch[]
  listings?: Listing[]
  owners?: Owner[]
  searchListings?: SearchListing[]
  scrapeRuns?: ScrapeRun[]
  runListingStatuses?: RunListingStatusRecord[]
  scrapeLogs?: ScrapeLog[]
  listingChanges?: ListingChange[]
}

export interface IngestResult {
  ok: true
  counts: Record<string, number>
}
