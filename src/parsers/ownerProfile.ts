function text(el: Element | null | undefined): string {
  return el?.textContent?.trim() ?? ''
}

function parseCountFromText(raw: string): number | undefined {
  const patterns = [
    /(\d+)\s*(?:active\s+)?(?:ads|listings|posts)\b/i,
    /(\d+)\s*հայտարարություն/i,
    /հայտարարություն[ներ]*\s*[:\-]?\s*(\d+)/i,
    /\((\d+)\)\s*(?:ads|listings|հայտարարություն)/i,
    /(?:ads|listings|հայտարարություն)\s*\((\d+)\)/i,
    /(?:ակտիվ|active)\s*[:\-]?\s*(\d+)/i,
  ]

  for (const pattern of patterns) {
    const match = raw.match(pattern)
    if (match) {
      const value = parseInt(match[1]!, 10)
      if (!Number.isNaN(value) && value >= 0) return value
    }
  }

  return undefined
}

function parseCountFromTestId(el: Element): number | undefined {
  const testId = el.getAttribute('data-testid') ?? ''
  const match = testId.match(/(\d+)(?:-count)?$/)
  if (match) {
    const value = parseInt(match[1]!, 10)
    if (!Number.isNaN(value) && value >= 0) return value
  }
  return parseCountFromText(text(el))
}

export interface OwnerProfileData {
  sitePostsCount?: number
  name?: string
  avatarUrl?: string
  isVerifiedCompany?: boolean
  rating?: number
  reviewCount?: number
  tenureText?: string
  description?: string
}

export function parseOwnerPostsFromCard(card: ParentNode): number | undefined {
  const explicit = parseCountFromText(card.textContent ?? '')
  if (explicit != null) return explicit

  for (const el of card.querySelectorAll('[data-testid*="listing"], [data-testid*="ads"]')) {
    const fromTestId = parseCountFromText(el.textContent ?? '')
    if (fromTestId != null) return fromTestId
  }

  return undefined
}

/** New business profile header: `<div data-testid="seller-profile-active-ad-count">81 հայտարարություն</div>` */
function parseSellerProfileActiveAdCount(doc: Document): number | undefined {
  const el = doc.querySelector('[data-testid="seller-profile-active-ad-count"]')
  if (!el) return undefined
  return parseCountFromText(text(el))
}

/**
 * Business/shop profiles show per-category totals in the sidebar, e.g.
 * `<a href="/user/22467?c=62"><span class="category-title-text">Վաճառք</span><span class="adsCount">2</span></a>`
 * There is often no single "X posts" label — sum category counts instead.
 */
function parseBusinessCategoryPostCount(doc: Document): number | undefined {
  const filter = doc.querySelector('[data-testid="business-page-category-filter"]')
  if (!filter) return undefined

  let total = 0
  let found = false

  const categoryLinks = filter.querySelectorAll('a[href*="?c="] .adsCount')
  const countElements =
    categoryLinks.length > 0 ? categoryLinks : filter.querySelectorAll('.adsCount')

  countElements.forEach((el) => {
    const value = parseInt(text(el), 10)
    if (!Number.isNaN(value) && value >= 0) {
      total += value
      found = true
    }
  })

  return found ? total : undefined
}

function collectDirectPostCountCandidates(doc: Document): number[] {
  const candidates: number[] = []
  const profileRoot =
    doc.querySelector(
      '[data-testid*="user-profile"], .user-profile, .user-page, .profile-page, main, #main',
    ) ?? doc.body

  const explicitSelectors = [
    '[data-testid="seller-profile-active-ad-count"]',
    '[data-testid*="active-ad-count"]',
    '[data-testid*="user-listings-count"]',
    '[data-testid*="listing-count"]',
    '[data-testid*="ads-count"]',
    '[data-testid*="active-listings"]',
    '.user-listings-count',
    '.user-ads-count',
    '.user-profile-listings-count',
    '.profile-listings-count',
  ]

  for (const selector of explicitSelectors) {
    profileRoot.querySelectorAll(selector).forEach((el) => {
      const value = parseCountFromTestId(el)
      if (value != null) candidates.push(value)
    })
  }

  const tabSelectors = [
    '[role="tab"]',
    '.tabs a',
    '.tab a',
    'nav a',
    '[data-testid*="tab"]',
  ]
  for (const selector of tabSelectors) {
    profileRoot.querySelectorAll(selector).forEach((el) => {
      const label = text(el)
      if (!/հայտարարություն|listing|ads|posts/i.test(label)) return
      const value = parseCountFromText(label)
      if (value != null) candidates.push(value)
    })
  }

  const headingSelectors = [
    'h1',
    'h2',
    '.user-profile-title',
    '[data-testid*="user-name"]',
    '.username',
    '.profile-header',
  ]
  for (const selector of headingSelectors) {
    profileRoot.querySelectorAll(selector).forEach((el) => {
      const value = parseCountFromText(text(el))
      if (value != null) candidates.push(value)
    })
  }

  profileRoot
    .querySelectorAll('[aria-label], [title]')
    .forEach((el) => {
      const label = `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('title') ?? ''}`
      if (!/հայտարարություն|listing|ads|posts/i.test(label)) return
      const value = parseCountFromText(label)
      if (value != null) candidates.push(value)
    })

  return candidates
}

function parseProfileIdentity(doc: Document): Partial<OwnerProfileData> {
  const profileRoot =
    doc.querySelector(
      '[data-testid="seller-profile-business-header"], [data-testid="seller-profile-identity"], [data-testid*="user-profile"], .user-profile, #uinfo, main, #main',
    ) ?? doc.body

  const name =
    text(
      profileRoot.querySelector(
        '[data-testid="seller-profile-name"], [data-testid*="user-name"], .user-profile-title, .username .nmsp, h1',
      ),
    ) || undefined

  const ratingText = text(
    profileRoot.querySelector('.post-view-seller-rating-score, [data-testid*="rating-score"]'),
  )
  const rating = ratingText ? parseFloat(ratingText) : undefined

  const reviewCountText = text(
    profileRoot.querySelector(
      '.post-view-seller-review-count, [data-testid*="review-count"], [data-testid="seller-profile-rating-summary"]',
    ),
  )
  const reviewCountMatch = reviewCountText.match(/\d+/)

  const avatarEl = profileRoot.querySelector('img[data-testid="user-avatar"], img.av_user')
  const avatarUrl = avatarEl?.getAttribute('src') ?? undefined

  return {
    name,
    avatarUrl,
    rating: rating !== undefined && !Number.isNaN(rating) ? rating : undefined,
    reviewCount: reviewCountMatch ? parseInt(reviewCountMatch[0]!, 10) : undefined,
    isVerifiedCompany: !!profileRoot.querySelector('.icon-company-verified'),
    tenureText:
      text(profileRoot.querySelector('.UserTenureComponent, [data-testid*="tenure"]')) ||
      undefined,
    description:
      text(profileRoot.querySelector('.additional-info .desc, [data-testid*="description"]')) ||
      undefined,
  }
}

export function isOwnerProfilePage(html: string): boolean {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const profileMarkers = [
    '[data-testid="seller-profile-page"]',
    '[data-testid="seller-profile-name"]',
    '[data-testid="seller-profile-active-ads"]',
    '[data-testid="business-page-category-filter"]',
    '[data-testid="seller-profile-identity"]',
    '#uinfo',
  ]

  if (profileMarkers.some((selector) => doc.querySelector(selector))) {
    return true
  }

  return !!(
    doc.querySelector('#menul') &&
    doc.querySelector('.user-page-ads, [data-testid="seller-profile-active-ads"]')
  )
}

export function getOwnerProfileFetchError(
  html: string,
  finalUrl: string,
  ownerId: string,
): string {
  if (isOwnerProfilePage(html)) {
    return 'Post count not found on profile page'
  }

  const homepagePattern = /^https?:\/\/(?:www\.)?list\.am(?:\/(?:am|en|ru))?\/?(?:[?#].*)?$/i
  if (homepagePattern.test(finalUrl)) {
    return `Profile unavailable — /user/${ownerId} redirected to homepage (deleted or invalid account)`
  }

  if (!finalUrl.includes(`/user/${ownerId}`)) {
    return `Profile unavailable — redirected to ${finalUrl}`
  }

  if (/գոյություն չունի|does not exist|не существует/i.test(html)) {
    return 'Profile does not exist on list.am'
  }

  return 'Post count not found on profile page'
}

/** Parse seller profile page HTML — post count comes from profile UI, not listing cards. */
export function parseOwnerProfilePage(html: string): OwnerProfileData {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const activeAdCount = parseSellerProfileActiveAdCount(doc)
  const businessCategoryTotal = parseBusinessCategoryPostCount(doc)
  const candidates = collectDirectPostCountCandidates(doc)

  return {
    ...parseProfileIdentity(doc),
    sitePostsCount:
      activeAdCount ??
      businessCategoryTotal ??
      (candidates.length > 0 ? Math.max(...candidates) : undefined),
  }
}
