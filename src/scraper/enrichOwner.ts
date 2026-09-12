import { db } from '../db'
import { fetchHtml } from '../network/fetchHtml'
import { parseOwnerProfilePage } from '../parsers/ownerProfile'
import type { OwnerData } from '../types'
import { fetchAndSaveOwnerProfile } from './ownerProfileSync'

export async function enrichOwnerWithProfileData(
  owner: OwnerData,
  signal: AbortSignal,
): Promise<OwnerData> {
  const existing = await db.owners.get(owner.id)
  if (existing?.sitePostsCount != null) {
    return { ...owner, sitePostsCount: existing.sitePostsCount }
  }

  const result = await fetchAndSaveOwnerProfile(owner.id, signal)
  if (result.sitePostsCount != null) {
    return { ...owner, sitePostsCount: result.sitePostsCount }
  }

  if (owner.sitePostsCount != null) return owner

  try {
    const html = await fetchHtml(`/user/${owner.id}`, signal, undefined, { dedicatedPage: true })
    const profile = parseOwnerProfilePage(html)
    if (profile.sitePostsCount != null) {
      return { ...owner, sitePostsCount: profile.sitePostsCount }
    }
  } catch {
    // Profile fetch is best-effort during detail scrape.
  }

  return owner
}
