import { BROKER_LISTING_THRESHOLD } from '../config'
import type { Owner } from '../types'

export type OwnerProfileType = 'agency' | 'broker' | 'likely_owner' | 'uncertain'

type OwnerClassificationInput = Pick<
  Owner,
  'isVerifiedCompany' | 'sitePostsCount' | 'rating' | 'reviewCount'
>

function getEffectivePostCount(owner: Owner, scrapedPostsCount = 1): number {
  return owner.sitePostsCount ?? scrapedPostsCount
}

function classifyOwner(
  postCount: number,
  owner: Owner,
): { profileType: OwnerProfileType } {
  if (owner.isVerifiedCompany) {
    return { profileType: 'agency' }
  }

  if (postCount >= BROKER_LISTING_THRESHOLD) {
    return { profileType: 'broker' }
  }

  if (postCount <= 2) {
    return { profileType: 'likely_owner' }
  }

  return { profileType: 'uncertain' }
}

function getOwnerProfileType(
  owner: OwnerClassificationInput,
  scrapedPostsCount = 1,
): OwnerProfileType {
  const postCount = getEffectivePostCount(owner as Owner, scrapedPostsCount)
  return classifyOwner(postCount, owner as Owner).profileType
}

/** True for private sellers; false for agencies and likely brokers. */
export function isLikelyOwnerPost(
  owner: OwnerClassificationInput,
  scrapedPostsCount = 1,
): boolean {
  const profileType = getOwnerProfileType(owner, scrapedPostsCount)
  return profileType === 'likely_owner' || profileType === 'uncertain'
}
