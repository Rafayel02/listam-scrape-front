import { db } from '../db'
import { hashImageUrls, type ImagePhashEntry } from '../network/hashImages'
import type { Listing } from '../types'

export async function hashAndStoreListingImages(
  listingId: string,
  imageUrls: string[],
): Promise<ImagePhashEntry[]> {
  const hashes = await hashImageUrls(imageUrls)
  if (hashes.length > 0) {
    await db.listings.update(listingId, { imagePhashes: hashes })
  }
  return hashes
}

export async function hashAllCompleteListings(
  onProgress?: (current: number, total: number, listingId: string) => void,
): Promise<{ processed: number; hashed: number }> {
  const listings = await db.listings
    .filter((listing) => listing.enrichmentStatus === 'complete' && !listing.isRemoved)
    .toArray()

  const withImages = listings.filter((l) => (l.imageUrls?.length ?? 0) > 0)
  let hashed = 0

  for (let i = 0; i < withImages.length; i++) {
    const listing = withImages[i]!
    onProgress?.(i + 1, withImages.length, listing.id)
    const entries = await hashAndStoreListingImages(listing.id, listing.imageUrls ?? [])
    if (entries.length > 0) hashed++
  }

  return { processed: withImages.length, hashed }
}

export function listingHasImageHashes(listing: Listing): boolean {
  return (listing.imagePhashes?.length ?? 0) > 0
}
