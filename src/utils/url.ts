const SESSION_PARAMS = ['seen_ids', 'unseen']

export function normalizeSearchUrl(url: string): string {
  const parsed = new URL(url)
  for (const param of SESSION_PARAMS) {
    parsed.searchParams.delete(param)
  }
  return parsed.toString()
}

function pathParts(url: string): string[] {
  return new URL(url).pathname.split('/').filter(Boolean)
}

interface CategoryPathInfo {
  categoryId: string
  page: number
  categoryIndex: number
}

/** Parse `/category/{id}` or `/category/{id}/{page}` (also works with `/en/category/...`). */
function parseCategoryPath(parts: string[]): CategoryPathInfo | null {
  const categoryIndex = parts.indexOf('category')
  if (categoryIndex === -1 || categoryIndex + 1 >= parts.length) return null

  const categoryId = parts[categoryIndex + 1]!
  if (!/^\d+$/.test(categoryId)) return null

  const maybePage = parts[categoryIndex + 2]
  const page =
    maybePage && /^\d+$/.test(maybePage) ? parseInt(maybePage, 10) : 1

  return { categoryId, page, categoryIndex }
}

export function getStartPage(url: string): number {
  const parsed = new URL(url)
  const parts = pathParts(url)

  const category = parseCategoryPath(parts)
  if (category) return category.page

  const pg = parsed.searchParams.get('pg')
  if (pg && /^\d+$/.test(pg)) {
    return parseInt(pg, 10)
  }

  const last = parts[parts.length - 1]
  if (last && /^\d+$/.test(last)) {
    return parseInt(last, 10)
  }

  return 1
}

export function buildPageUrl(baseUrl: string, page: number): string {
  const parsed = new URL(baseUrl)
  const parts = pathParts(baseUrl)

  const category = parseCategoryPath(parts)
  if (category) {
    const prefix = parts.slice(0, category.categoryIndex)
    const next = [...prefix, 'category', category.categoryId]
    if (page > 1) next.push(String(page))
    parsed.pathname = `/${next.join('/')}`
  } else if (parts.length > 0 && /^\d+$/.test(parts[parts.length - 1]!)) {
    parts[parts.length - 1] = String(page)
    parsed.pathname = `/${parts.join('/')}`
  } else if (page > 1) {
    parts.push(String(page))
    parsed.pathname = `/${parts.join('/')}`
  }

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
  const parts = pathParts(url)

  const category = parseCategoryPath(parts)
  if (category) return category.page

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

  const parts = pathParts(actualUrl)
  const category = parseCategoryPath(parts)
  if (category) {
    return category.page !== requestedPage
  }

  const hasPageInPath = parts.length > 0 && /^\d+$/.test(parts[parts.length - 1]!)
  return !hasPageInPath
}
