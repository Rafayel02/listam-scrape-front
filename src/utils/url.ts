const SESSION_PARAMS = ['seen_ids', 'unseen']

export function normalizeSearchUrl(url: string): string {
  const parsed = new URL(url)
  for (const param of SESSION_PARAMS) {
    parsed.searchParams.delete(param)
  }
  return parsed.toString()
}

export function getStartPage(url: string): number {
  const parsed = new URL(url)
  const parts = parsed.pathname.split('/').filter(Boolean)
  const last = parts[parts.length - 1]
  if (/^\d+$/.test(last)) {
    return parseInt(last, 10)
  }
  return 1
}

export function buildPageUrl(baseUrl: string, page: number): string {
  const parsed = new URL(baseUrl)
  const parts = parsed.pathname.split('/').filter(Boolean)

  if (parts.length > 0 && /^\d+$/.test(parts[parts.length - 1]!)) {
    parts[parts.length - 1] = String(page)
  } else {
    parts.push(String(page))
  }

  parsed.pathname = `/${parts.join('/')}`

  if (parsed.searchParams.has('pg')) {
    parsed.searchParams.set('pg', String(page))
  }

  return parsed.toString()
}

export function toFetchPath(fullUrl: string): string {
  const parsed = new URL(fullUrl)
  return `${parsed.pathname}${parsed.search}`
}

/** Page number list.am is actually serving (path segment or `pg` query, default 1). */
export function getListAmSearchPageFromUrl(url: string): number {
  const parsed = new URL(url)
  const parts = parsed.pathname.split('/').filter(Boolean)

  if (parts[0] === 'category' && parts.length >= 3) {
    const pagePart = parts[parts.length - 1]!
    if (/^\d+$/.test(pagePart)) {
      return parseInt(pagePart, 10)
    }
  }

  const pg = parsed.searchParams.get('pg')
  if (pg && /^\d+$/.test(pg)) {
    return parseInt(pg, 10)
  }

  return 1
}

/**
 * True when list.am refused the requested page (redirect/strip), e.g.
 * `/category/56/28` → `/category/56`.
 */
export function isPastLastSearchPage(requestedPage: number, actualUrl: string): boolean {
  if (requestedPage <= 1) return false

  const actualPage = getListAmSearchPageFromUrl(actualUrl)
  if (actualPage !== requestedPage) return true

  const parts = new URL(actualUrl).pathname.split('/').filter(Boolean)
  const hasPageInPath =
    parts[0] === 'category' && parts.length >= 3 && /^\d+$/.test(parts[parts.length - 1]!)

  return !hasPageInPath
}
