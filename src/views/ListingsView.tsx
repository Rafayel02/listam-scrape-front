import { liveQuery } from 'dexie'
import { useEffect, useMemo, useState } from 'react'
import { db } from '../db'
import { scrapeListingItem } from '../scraper/scrapeItem'
import type { EnrichmentStatus, Listing, ListingChange, Owner } from '../types'
import { formatChangeValue } from '../utils/listingDiff'

type DetailFilter = 'all' | EnrichmentStatus

function formatDate(ts?: number): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleDateString()
}

function formatPosted(listing: Listing): string {
  if (listing.postedAt) return formatDate(listing.postedAt)
  return '—'
}

function formatRenewed(listing: Listing): string {
  if (listing.renewedAt) return formatDate(listing.renewedAt)
  return '—'
}

function formatPrice(listing: Listing): string {
  if (listing.price == null) return '—'
  const cur = listing.currency ?? ''
  const suffix = listing.isMonthly ? '/mo' : ''
  return `${listing.price.toLocaleString()} ${cur}${suffix}`
}

function detailLabel(status: EnrichmentStatus): string {
  switch (status) {
    case 'pending':
      return 'detail: queued'
    case 'processing':
      return 'detail: fetching'
    case 'complete':
      return 'detail: done'
    case 'failed':
      return 'detail: failed'
    case 'removed':
      return 'removed'
  }
}

export function ListingsView() {
  const [listings, setListings] = useState<Listing[]>([])
  const [owners, setOwners] = useState<Owner[]>([])
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [changes, setChanges] = useState<ListingChange[]>([])
  const [detailFilter, setDetailFilter] = useState<DetailFilter>('all')
  const [ownerFilterId, setOwnerFilterId] = useState<string | null>(null)
  const [districtFilter, setDistrictFilter] = useState<string | null>(null)
  const [scrapingIds, setScrapingIds] = useState<Set<string>>(new Set())
  const [scrapeErrors, setScrapeErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    const sub = liveQuery(() =>
      db.listings.orderBy('lastSeenAt').reverse().toArray(),
    ).subscribe({
      next: (v) => setListings(v),
    })
    return () => sub.unsubscribe()
  }, [])

  useEffect(() => {
    const sub = liveQuery(() => db.owners.orderBy('lastSeenAt').reverse().toArray()).subscribe({
      next: (v) => setOwners(v),
    })
    return () => sub.unsubscribe()
  }, [])

  useEffect(() => {
    if (!expandedId) {
      setChanges([])
      return
    }
    const sub = liveQuery(() =>
      db.listingChanges.where('listingId').equals(expandedId).sortBy('changedAt'),
    ).subscribe({
      next: (v) => setChanges(v),
    })
    return () => sub.unsubscribe()
  }, [expandedId])

  const counts = useMemo(
    () => ({
      complete: listings.filter((l) => l.enrichmentStatus === 'complete').length,
      processing: listings.filter((l) => l.enrichmentStatus === 'processing').length,
      pending: listings.filter((l) => l.enrichmentStatus === 'pending').length,
      failed: listings.filter((l) => l.enrichmentStatus === 'failed').length,
      removed: listings.filter((l) => l.enrichmentStatus === 'removed' || l.isRemoved).length,
    }),
    [listings],
  )

  const ownersById = useMemo(
    () => new Map(owners.map((owner) => [owner.id, owner])),
    [owners],
  )

  const availableDistricts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const listing of listings) {
      const district = listing.district?.trim()
      if (!district) continue
      counts.set(district, (counts.get(district) ?? 0) + 1)
    }
    return [...counts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: 'base' }))
      .map(([district, count]) => ({ district, count }))
  }, [listings])

  const visibleListings = useMemo(() => {
    let rows = listings
    if (detailFilter === 'removed') {
      rows = rows.filter((l) => l.enrichmentStatus === 'removed' || l.isRemoved)
    } else if (detailFilter !== 'all') {
      rows = rows.filter((l) => l.enrichmentStatus === detailFilter)
    }
    if (ownerFilterId) {
      rows = rows.filter((l) => l.ownerId === ownerFilterId)
    }
    if (districtFilter) {
      rows = rows.filter((l) => (l.district?.trim() ?? '') === districtFilter)
    }
    return rows
  }, [listings, detailFilter, ownerFilterId, districtFilter])

  const ownerListingCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const listing of listings) {
      if (!listing.ownerId) continue
      counts.set(listing.ownerId, (counts.get(listing.ownerId) ?? 0) + 1)
    }
    return counts
  }, [listings])

  async function handleScrapeItem(listingId: string): Promise<void> {
    setScrapeErrors((prev) => {
      const next = { ...prev }
      delete next[listingId]
      return next
    })
    setScrapingIds((prev) => new Set(prev).add(listingId))

    try {
      const result = await scrapeListingItem(listingId)
      setExpandedId(listingId)
      if (result.detail.removed) {
        setScrapeErrors((prev) => ({
          ...prev,
          [listingId]: 'Listing was removed on list.am',
        }))
      } else if (result.changeCount === 0) {
        setScrapeErrors((prev) => ({
          ...prev,
          [listingId]: 'Scraped — no new fields changed (check JSON below)',
        }))
      }
    } catch (err) {
      setScrapeErrors((prev) => ({
        ...prev,
        [listingId]: (err as Error).message,
      }))
    } finally {
      setScrapingIds((prev) => {
        const next = new Set(prev)
        next.delete(listingId)
        return next
      })
    }
  }

  return (
    <div className="view">
      <h2>Listings ({listings.length})</h2>

      <p className="muted small">
        Stage 1 (card): search-page data saved for every listing.
        Stage 2 (detail): each <code>/item/</code> page is fetched in a background tab.
      </p>

      {listings.length > 0 && (
        <div className="stats" style={{ marginBottom: '0.75rem' }}>
          <span>Card data: {listings.length}</span>
          <span>Detail done: {counts.complete}</span>
          <span>Fetching: {counts.processing}</span>
          <span>Queued: {counts.pending}</span>
          <span>Failed: {counts.failed}</span>
          <span>Removed: {counts.removed}</span>
        </div>
      )}

      {owners.length > 0 && (
        <div className="stats" style={{ marginBottom: '0.75rem' }}>
          <span>Owners: {owners.length}</span>
          {ownerFilterId && (
            <button type="button" onClick={() => setOwnerFilterId(null)}>
              Clear owner filter
            </button>
          )}
        </div>
      )}

      {listings.length > 0 && (
        <div className="btn-group" style={{ marginBottom: '1rem' }}>
          {(['all', 'complete', 'processing', 'pending', 'failed', 'removed'] as DetailFilter[]).map(
            (filter) => (
              <button
                key={filter}
                type="button"
                className={detailFilter === filter ? 'btn-primary' : ''}
                onClick={() => setDetailFilter(filter)}
              >
                {filter === 'all' ? 'All' : detailLabel(filter as EnrichmentStatus)}
              </button>
            ),
          )}
        </div>
      )}

      {availableDistricts.length > 0 && (
        <div className="form-row" style={{ marginBottom: '1rem', alignItems: 'center' }}>
          <label htmlFor="district-filter">
            District
            <select
              id="district-filter"
              value={districtFilter ?? ''}
              onChange={(e) => setDistrictFilter(e.target.value || null)}
              style={{ marginLeft: '0.5rem' }}
            >
              <option value="">All districts ({listings.length})</option>
              {availableDistricts.map(({ district, count }) => (
                <option key={district} value={district}>
                  {district} ({count})
                </option>
              ))}
            </select>
          </label>
          {districtFilter && (
            <button type="button" onClick={() => setDistrictFilter(null)}>
              Clear district
            </button>
          )}
        </div>
      )}

      {listings.length === 0 && <p className="muted">No listings stored yet.</p>}

      {listings.length > 0 && (
        <p className="muted small" style={{ marginBottom: '0.75rem' }}>
          Showing {visibleListings.length} of {listings.length}
          {districtFilter ? ` in ${districtFilter}` : ''}
          {ownerFilterId ? ' (owner filtered)' : ''}
        </p>
      )}

      <div className="listings">
        {visibleListings.map((listing) => {
          const owner = listing.ownerId ? ownersById.get(listing.ownerId) : undefined
          return (
          <div key={listing.id} className="listing-card">
            <div className="listing-row" onClick={() => setExpandedId(
              expandedId === listing.id ? null : listing.id,
            )}>
              {listing.thumbnailUrl && (
                <img src={listing.thumbnailUrl} alt="" className="thumb" />
              )}
              <div className="listing-main">
                <div className="listing-title">
                  {listing.isRemoved ? '[Removed] ' : ''}
                  {listing.title || listing.id}
                </div>
                <div className="listing-meta">
                  <span>{formatPrice(listing)}</span>
                  {listing.rooms != null && <span>{listing.rooms} rm</span>}
                  {listing.areaSqm != null && <span>{listing.areaSqm} m²</span>}
                  {listing.district && (
                    <button
                      type="button"
                      className="owner-link"
                      onClick={(e) => {
                        e.stopPropagation()
                        setDistrictFilter(listing.district!.trim())
                      }}
                    >
                      {listing.district}
                    </button>
                  )}
                  {listing.currentFloor != null && listing.totalFloors != null && (
                    <span>{listing.currentFloor}/{listing.totalFloors} fl</span>
                  )}
                </div>
                <div className="listing-meta small">
                  {owner && (
                    <button
                      type="button"
                      className="owner-link"
                      onClick={(e) => {
                        e.stopPropagation()
                        setOwnerFilterId(owner.id)
                      }}
                    >
                      Owner: {owner.name || owner.id}
                      {owner.isVerifiedCompany ? ' ✓' : ''}
                    </button>
                  )}
                  <span>Posted (list.am): {formatPosted(listing)}</span>
                  <span>Renewed (list.am): {formatRenewed(listing)}</span>
                  <span>First seen: {formatDate(listing.firstSeenAt)}</span>
                  <span>Last seen: {formatDate(listing.lastSeenAt)}</span>
                  <span className="badge badge-complete">card ✓</span>
                  <span className={`badge badge-${listing.enrichmentStatus}`}>
                    {detailLabel(listing.enrichmentStatus)}
                  </span>
                  {listing.description && (
                    <span className="muted">has description</span>
                  )}
                  {listing.imageUrls?.length ? (
                    <span className="muted">{listing.imageUrls.length} images</span>
                  ) : null}
                  {listing.attributes && (
                    <span className="muted">{Object.keys(listing.attributes).length} attrs</span>
                  )}
                </div>
              </div>
              <div className="listing-actions" onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  className="scrape-link"
                  disabled={scrapingIds.has(listing.id)}
                  onClick={() => void handleScrapeItem(listing.id)}
                >
                  {scrapingIds.has(listing.id) ? 'Scraping…' : 'Scrape item'}
                </button>
                <a
                  href={listing.url}
                  target="_blank"
                  rel="noreferrer"
                  className="open-link"
                >
                  Open
                </a>
              </div>
            </div>

            {scrapeErrors[listing.id] && (
              <p className="scrape-error small" onClick={(e) => e.stopPropagation()}>
                {scrapeErrors[listing.id]}
              </p>
            )}

            {expandedId === listing.id && (
              <div className="inspector">
                {owner && (
                  <>
                    <h4>Owner</h4>
                    <div className="owner-card">
                      {owner.avatarUrl && (
                        <img src={owner.avatarUrl} alt="" className="owner-avatar" />
                      )}
                      <div>
                        <div>
                          <strong>{owner.name || owner.id}</strong>
                          {owner.isVerifiedCompany && <span> (verified company)</span>}
                        </div>
                        <div className="small muted">
                          {owner.rating != null && <span>Rating: {owner.rating}</span>}
                          {owner.reviewCount != null && <span> · {owner.reviewCount} reviews</span>}
                          {owner.tenureText && <span> · {owner.tenureText}</span>}
                          <span>
                            {' '}
                            · {ownerListingCounts.get(owner.id) ?? 1} listing
                            {(ownerListingCounts.get(owner.id) ?? 1) === 1 ? '' : 's'} stored
                          </span>
                        </div>
                        {owner.description && <p className="small">{owner.description}</p>}
                        <div className="btn-group" style={{ marginTop: '0.5rem' }}>
                          <a
                            href={`https://www.list.am${owner.profileUrl}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Profile
                          </a>
                          {owner.reviewsUrl && (
                            <a
                              href={`https://www.list.am${owner.reviewsUrl}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Reviews
                            </a>
                          )}
                          <button type="button" onClick={() => setOwnerFilterId(owner.id)}>
                            Show all from this owner
                          </button>
                        </div>
                      </div>
                    </div>
                  </>
                )}

                <h4>All attributes</h4>
                <pre>{JSON.stringify(listing, null, 2)}</pre>

                <h4>Change history (scraper-observed)</h4>
                {changes.length === 0 && <p className="muted">No changes recorded.</p>}
                {changes.map((c) => (
                  <div key={c.id} className="change-entry">
                    <div className="small muted">
                      {new Date(c.changedAt).toLocaleString()} (run {c.scrapeRunId.slice(0, 8)})
                    </div>
                    <ul>
                      {c.changes.map((ch, i) => (
                        <li key={i}>
                          <strong>{ch.field}</strong>: {formatChangeValue(ch.from)} →{' '}
                          {formatChangeValue(ch.to)}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </div>
          )
        })}
      </div>
    </div>
  )
}
