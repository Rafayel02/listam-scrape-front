import type { DetailData, OwnerData, PriceHistoryEntry } from '../types'

function text(el: Element | null | undefined): string {
  return el?.textContent?.trim() ?? ''
}

function parseDate(raw: string): number | undefined {
  if (!raw) return undefined

  const dotted = raw.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/)
  if (dotted) {
    const day = parseInt(dotted[1]!, 10)
    const month = parseInt(dotted[2]!, 10) - 1
    const year = parseInt(dotted[3]!, 10)
    const ts = Date.UTC(year, month, day)
    return Number.isNaN(ts) ? undefined : ts
  }

  const ts = Date.parse(raw)
  return Number.isNaN(ts) ? undefined : ts
}

function parseRenewedAt(bodyText: string): { renewedAt?: number; renewedRaw?: string } {
  const renewedMatch = bodyText.match(
    /(?:Renewed|Updated|Թարմացվել(?:\s+է)?|Обновлено)[^\d]*(\d{1,2}\.\d{1,2}\.\d{4}(?:,\s*\d{1,2}:\d{2})?)/i,
  )
  const renewedRaw = renewedMatch?.[1]
  return {
    renewedAt: renewedRaw ? parseDate(renewedRaw) : undefined,
    renewedRaw,
  }
}

function resolveImageSrc(src: string | null | undefined, baseUrl: string): string | undefined {
  if (!src) return undefined
  if (src.startsWith('//')) return `https:${src}`
  try {
    return new URL(src, baseUrl).toString()
  } catch {
    return undefined
  }
}

function valueLooksLikeData(value: string): boolean {
  return /\d/.test(value) || /քմ|մ\b|֏|\$|₽|եՎ|ամս|հարկ|Yes|Այո|Ոչ/i.test(value)
}

function parseAt3(el: Element): { key: string; value: string } | null {
  const wrapper = el.querySelector('.attr-info-wraper')
  const paragraphs = wrapper
    ? Array.from(wrapper.querySelectorAll('p')).map((p) => text(p)).filter(Boolean)
    : []

  if (paragraphs.length >= 2) {
    const [first, second] = paragraphs
    if (valueLooksLikeData(first)) {
      return { key: second, value: first }
    }
    return { key: first, value: second }
  }

  const single = text(el.querySelector('.attr-value')) || paragraphs[0]
  if (!single) return null
  return { key: single, value: 'Yes' }
}

function parseAttributeSections(root: ParentNode): Record<string, Record<string, string>> {
  const sections: Record<string, Record<string, string>> = {}
  let currentSection = 'General'

  root.querySelectorAll('.gt, .attr.g').forEach((node) => {
    if (node.classList.contains('gt')) {
      currentSection = text(node) || currentSection
      if (!sections[currentSection]) sections[currentSection] = {}
      return
    }

    if (!sections[currentSection]) sections[currentSection] = {}

    node.querySelectorAll('.at3').forEach((at3) => {
      if (at3.classList.contains('disabled')) return
      const parsed = parseAt3(at3)
      if (parsed) sections[currentSection][parsed.key] = parsed.value
    })
  })

  return sections
}

function flattenSections(sections: Record<string, Record<string, string>>): Record<string, string> {
  const flat: Record<string, string> = {}
  for (const [section, attrs] of Object.entries(sections)) {
    for (const [key, value] of Object.entries(attrs)) {
      const compositeKey = section === 'General' ? key : `${section}: ${key}`
      flat[compositeKey] = value
    }
  }
  return flat
}

function parseGalleryImages(doc: Document, baseUrl: string): string[] {
  const imageUrls: string[] = []
  const gallery = doc.querySelector('[data-testid="listing-image-gallery"], #po111, .po111')

  const imgs = gallery
    ? gallery.querySelectorAll('img[data-testid^="listing-gallery-image"], img[itemprop="image"]')
    : doc.querySelectorAll('#pcontent img[itemprop="image"], .vi img[src*="img.list"]')

  imgs.forEach((img) => {
    const src = resolveImageSrc(
      img.getAttribute('src') || img.getAttribute('data-original') || img.getAttribute('data-src'),
      baseUrl,
    )
    if (src && !imageUrls.includes(src) && /img\.list\.am|upa\.list\.am/i.test(src)) {
      imageUrls.push(src)
    }
  })

  return imageUrls
}

function parsePriceHistory(doc: Document): PriceHistoryEntry[] {
  const sourcePriceHistory: PriceHistoryEntry[] = []

  doc.querySelectorAll('.price_history table tr').forEach((row) => {
    const cells = Array.from(row.querySelectorAll('td, th')).map((c) => text(c))
    if (cells.length < 2 || !/\d/.test(cells.join(''))) return

    const entry: PriceHistoryEntry = { raw: cells.join(' | ') }
    const priceCell = cells.find((c) => /[\d,]+/.test(c) && /֏|\$|₽|AMD/i.test(c)) ?? cells[1]
    const priceMatch = priceCell?.replace(/,/g, '').match(/[\d.]+/)
    if (priceMatch) entry.price = parseFloat(priceMatch[0])

    const dateCell = cells.find((c) => /\d{4}/.test(c) && !/[\d,]+֏/.test(c)) ?? cells[0]
    if (dateCell) entry.date = dateCell

    const changeCell = cells.find((c) => /[▲▼]/.test(c) || /^[+-]/.test(c))
    if (changeCell) entry.raw = `${entry.raw} | ${changeCell}`

    sourcePriceHistory.push(entry)
  })

  return sourcePriceHistory
}

function parsePostedAt(doc: Document, bodyText: string): { postedAt?: number; postedRaw?: string } {
  const datePostedEl = doc.querySelector('[itemprop="datePosted"]')
  const iso = datePostedEl?.getAttribute('content')
  if (iso) {
    const ts = Date.parse(iso)
    if (!Number.isNaN(ts)) {
      return { postedAt: ts, postedRaw: text(datePostedEl) || iso }
    }
  }

  const postedMatch = bodyText.match(
    /(?:Posted|Published|Տեղադրված(?:\s+է)?|Размещено)[^\d]*(\d{1,2}\.\d{1,2}\.\d{4})/i,
  )
  const postedRaw = postedMatch?.[1]
  return {
    postedAt: postedRaw ? parseDate(postedRaw) : undefined,
    postedRaw,
  }
}

function extractOwnerId(card: Element): string | undefined {
  for (const link of card.querySelectorAll('a[href*="/user/"], a[href*="/u/"]')) {
    const href = link.getAttribute('href') ?? ''
    const match = href.match(/\/(?:user|u)\/(\d+)/)
    if (match) return match[1]
  }

  for (const el of card.querySelectorAll('[data-testid^="favorite-ad-owner-link-"]')) {
    const testId = el.getAttribute('data-testid') ?? ''
    const match = testId.match(/favorite-ad-owner-link-(\d+)/)
    if (match) return match[1]
  }

  const reviewsHref = card.querySelector('a[href*="/reviews/"]')?.getAttribute('href') ?? ''
  const reviewsMatch = reviewsHref.match(/\/reviews\/(\d+)/)
  if (reviewsMatch) return reviewsMatch[1]

  return undefined
}

function parseOwner(doc: Document, baseUrl: string): OwnerData | undefined {
  const card = doc.querySelector('#uinfo.post-view-seller-card, .post-view-seller-card, #uinfo')
  if (!card) return undefined

  const id = extractOwnerId(card)
  if (!id) return undefined

  const reviewCountText = text(card.querySelector('.post-view-seller-review-count'))
  const reviewCountMatch = reviewCountText.match(/\d+/)
  const ratingText = text(card.querySelector('.post-view-seller-rating-score'))
  const rating = ratingText ? parseFloat(ratingText) : undefined
  return {
    id,
    profileUrl: `/user/${id}`,
    name: text(card.querySelector('.nmsp')) || undefined,
    avatarUrl: resolveImageSrc(
      card.querySelector('img[data-testid="user-avatar"], img.av_user')?.getAttribute('src'),
      baseUrl,
    ),
    isVerifiedCompany: !!card.querySelector('.icon-company-verified'),
    rating: rating !== undefined && !Number.isNaN(rating) ? rating : undefined,
    reviewCount: reviewCountMatch ? parseInt(reviewCountMatch[0]!, 10) : undefined,
    tenureText: text(card.querySelector('.UserTenureComponent')) || undefined,
    description: text(card.querySelector('.additional-info .desc')) || undefined,
    reviewsUrl: `/reviews/${id}`,
  }
}

function parseLegacyAttributes(doc: Document): Record<string, string> {
  const attributes: Record<string, string> = {}

  doc.querySelectorAll('dl').forEach((dl) => {
    const groups = dl.querySelectorAll(':scope > div')
    if (groups.length > 0) {
      groups.forEach((group) => {
        const key = text(group.querySelector('dt'))
        const value = text(group.querySelector('dd'))
        if (key) attributes[key] = value
      })
    } else {
      dl.querySelectorAll('dt').forEach((dt) => {
        const key = text(dt)
        const value = text(dt.nextElementSibling)
        if (key) attributes[key] = value
      })
    }
  })

  return attributes
}

const REMOVED_LISTING_PATTERNS = [
  /գոյություն չունի/i,
  /does not exist/i,
  /не существует/i,
  /ad has been removed/i,
  /հայտարարությունը հեռաց/i,
]

function detectRemovedListing(doc: Document): string | undefined {
  const candidates = [
    doc.querySelector('.bubble .anf h1'),
    doc.querySelector('.bubble h1'),
    doc.querySelector('#main .bubble h1'),
  ]

  for (const el of candidates) {
    const message = text(el)
    if (!message) continue
    if (REMOVED_LISTING_PATTERNS.some((pattern) => pattern.test(message))) {
      return message
    }
  }

  return undefined
}

export function parseDetailPage(html: string, baseUrl = 'https://www.list.am'): DetailData {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const removedMessage = detectRemovedListing(doc)
  if (removedMessage) {
    return {
      removed: true,
      removedMessage,
    }
  }

  const detailExtras: Record<string, unknown> = {}
  const contentRoot = doc.querySelector('#pcontent') ?? doc.body

  const title = text(doc.querySelector('h1[itemprop="name"], [data-testid="listing-details-title"]')) || undefined

  const location =
    text(doc.querySelector('.post-location-title p')) ||
    text(doc.querySelector('.loc a, #poi-map-anchor')) ||
    undefined

  const description =
    text(doc.querySelector('.body[itemprop="description"], #po_body, .body, [itemprop="description"], .cbody')) ||
    text(doc.querySelector('.descr')) ||
    undefined

  const attributeSections = parseAttributeSections(contentRoot)
  const modernAttributes = flattenSections(attributeSections)
  const legacyAttributes = parseLegacyAttributes(doc)
  const attributes = { ...legacyAttributes, ...modernAttributes }

  const imageUrls = parseGalleryImages(doc, baseUrl)
  const sourcePriceHistory = parsePriceHistory(doc)

  const bodyText = doc.body?.textContent ?? ''
  const posted = parsePostedAt(doc, bodyText)
  const renewed = parseRenewedAt(bodyText)

  const postedAt =
    posted.postedAt ||
    parseDate(attributes['Posted'] || attributes['Date'] || '') ||
    parseDate(Object.entries(attributes).find(([k]) => /post|date/i.test(k))?.[1] ?? '')

  const renewedAt =
    renewed.renewedAt ||
    parseDate(attributes['Renewed'] || attributes['Updated'] || '') ||
    parseDate(Object.entries(attributes).find(([k]) => /renew|update/i.test(k))?.[1] ?? '')

  const footerSpans = Array.from(doc.querySelectorAll('.footer span')).map((s) => text(s))
  const listingNumber = footerSpans.find((s) => /\d{6,}/.test(s))
  if (listingNumber) detailExtras.listingNumberText = listingNumber

  const metaTags = Array.from(doc.querySelectorAll('.po78 .ge3, .po78 span.ge3')).map((el) => text(el))
  const listingCode = metaTags.find((t) => /կոդ|code/i.test(t))
  const sellerType = metaTags.find((t) => !/կոդ|code/i.test(t))

  const verificationLabel = text(doc.querySelector('.prop-verif-label .pr85, .prop-verif-label span'))
  if (verificationLabel) detailExtras.propertyVerification = verificationLabel

  if (posted.postedRaw) detailExtras.postedRaw = posted.postedRaw
  if (renewed.renewedRaw) detailExtras.renewedRaw = renewed.renewedRaw

  const owner = parseOwner(doc, baseUrl)

  return {
    title,
    location,
    listingCode: listingCode || undefined,
    sellerType: sellerType || undefined,
    description: description || undefined,
    imageUrls: imageUrls.length ? imageUrls : undefined,
    attributes: Object.keys(attributes).length ? attributes : undefined,
    attributeSections: Object.keys(attributeSections).length ? attributeSections : undefined,
    sourcePriceHistory: sourcePriceHistory.length ? sourcePriceHistory : undefined,
    postedAt,
    renewedAt,
    owner,
    detailExtras: Object.keys(detailExtras).length ? detailExtras : undefined,
  }
}
