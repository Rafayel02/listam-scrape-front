import type { CardData } from '../types'

const EMPTY_MARKERS = [
  "couldn't find anything",
  'we could not find',
  'ничего не найдено',
  'Չգտնվեց',
]

export interface SearchPageParseResult {
  cards: CardData[]
  hasValidStructure: boolean
  isEmptyResults: boolean
}

function text(el: Element | null | undefined): string {
  return el?.textContent?.trim() ?? ''
}

function parsePrice(raw: string): { price?: number; currency?: string; isMonthly?: boolean } {
  const isMonthly = /monthly|ամսական|в месяц/i.test(raw)
  const currencyMatch = raw.match(/[$€֏]|AMD|USD|EUR/)
  const currency = currencyMatch?.[0]
  const numMatch = raw.replace(/,/g, '').match(/[\d.]+/)
  const price = numMatch ? parseFloat(numMatch[0]) : undefined
  return { price, currency, isMonthly }
}

function parseRoomsAreaFloor(summary: string): {
  rooms?: number
  areaSqm?: number
  currentFloor?: number
  totalFloors?: number
} {
  const roomsMatch = summary.match(/(\d+)\s*(room|rm|սեն|комн)/i)
  const areaMatch = summary.match(/(\d+(?:\.\d+)?)\s*(sq\.?\s*m|քմ|м²|кв)/i)
  const floorMatch = summary.match(/(\d+)\s*\/\s*(\d+)\s*(floor|հարկ|этаж)?/i)

  return {
    rooms: roomsMatch ? parseInt(roomsMatch[1]!, 10) : undefined,
    areaSqm: areaMatch ? parseFloat(areaMatch[1]!) : undefined,
    currentFloor: floorMatch ? parseInt(floorMatch[1]!, 10) : undefined,
    totalFloors: floorMatch ? parseInt(floorMatch[2]!, 10) : undefined,
  }
}

function extractListingId(href: string): string | null {
  const match = href.match(/\/item\/(\d+)/)
  return match?.[1] ?? null
}

function resolveUrl(href: string, baseUrl: string): string {
  const u = new URL(href, baseUrl)
  u.search = ''
  return u.toString()
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

const CARD_SELECTORS = [
  'a.category-data-list-grid-card__destination[href*="/item/"]',
  'a.fav-item-info-container[href*="/item/"]',
]

function queryCardElements(doc: Document): Element[] {
  for (const selector of CARD_SELECTORS) {
    const found = doc.querySelectorAll(selector)
    if (found.length > 0) return Array.from(found)
  }

  return Array.from(doc.querySelectorAll('a[href*="/item/"]')).filter((el) =>
    el.classList.contains('category-data-list-grid-card__destination') ||
    el.closest('.category-data-list-grid-card') !== null,
  )
}

export function parseSearchPage(html: string, baseUrl = 'https://www.list.am'): SearchPageParseResult {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const lowerHtml = html.toLowerCase()
  const isEmptyResults = EMPTY_MARKERS.some((m) => lowerHtml.includes(m.toLowerCase()))

  const elements = queryCardElements(doc)
  const hasValidStructure = elements.length > 0 || isEmptyResults

  const cards: CardData[] = []
  const seen = new Set<string>()

  elements.forEach((el) => {
    try {
      const href = el.getAttribute('href')
      if (!href) return

      const id = extractListingId(href)
      if (!id || seen.has(id)) return
      seen.add(id)

      const title =
        text(el.querySelector('.l')) ||
        text(el.querySelector('.dltitle .pt')) ||
        text(el.querySelector('.pt')) ||
        text(el.querySelector('[class*="title"]'))

      if (!title) return

      const amount = text(el.querySelector('.category-data-list-card__amount'))
      const frequency = text(el.querySelector('.category-data-list-card__price-frequency'))
      const legacyPrice = text(el.querySelector('.ad-info-line-wrapper .p')) || text(el.querySelector('.p'))
      const priceRaw = [amount, frequency].filter(Boolean).join(' ') || legacyPrice
      const { price, currency, isMonthly } = parsePrice(priceRaw)

      const atEls = el.querySelectorAll('.at')
      const atTexts = Array.from(atEls)
        .map((a) => text(a))
        .filter((t) => t && !t.includes('ստուգված'))
      const district =
        text(el.querySelector('.category-data-list-card__location')) ||
        atTexts.find((t) => t.length < 80) ||
        atTexts[0]

      const summary = text(el.querySelector('.d')) || text(el.querySelector('.l')) || title
      const floorInfo = parseRoomsAreaFloor(summary + ' ' + atTexts.join(' '))

      const img = el.querySelector('img')
      const thumbnailUrl = resolveImageSrc(
        img?.getAttribute('data-original') || img?.getAttribute('src') || img?.getAttribute('data-src'),
        baseUrl,
      )

      const badges: string[] = []
      el.querySelectorAll('[class*="badge"], [class*="label"], .i').forEach((b) => {
        const t = text(b)
        if (t && t.length < 40) badges.push(t)
      })

      const verificationStatus =
        text(el.querySelector('[class*="verified"]')) ||
        (lowerHtml.includes('verified') && badges.find((b) => /verified/i.test(b)))

      cards.push({
        id,
        url: resolveUrl(href, baseUrl),
        title,
        price,
        currency,
        isMonthly,
        thumbnailUrl,
        district,
        ...floorInfo,
        badges: badges.length ? badges : undefined,
        verificationStatus: verificationStatus || undefined,
        cardExtras: {
          priceRaw,
          atTexts,
          summary,
        },
      })
    } catch {
      // skip malformed card
    }
  })

  return { cards, hasValidStructure, isEmptyResults }
}
