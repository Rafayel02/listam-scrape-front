/** True when HTML looks like a real list.am results or detail page. */
export function isListAmPage(html: string): boolean {
  const lower = html.toLowerCase()

  if (lower.includes('fav-item-info-container')) return true
  if (lower.includes('category-data-list-grid-card__destination')) return true
  if (lower.includes('class="dltitle"')) return true
  if (lower.includes('post-view-layout')) return true
  if (lower.includes('data-testid="listing-details-title"')) return true
  if (lower.includes('post-view-seller-card')) return true
  if (lower.includes('href="/item/') || lower.includes("href='/item/")) return true
  if (lower.includes("couldn't find anything")) return true
  if (lower.includes('list.am') && lower.includes('/category/')) return true

  return false
}

/**
 * Detect Cloudflare challenge interstitial only — not CDN script tags on normal pages.
 */
export function isCloudflareChallenge(html: string): boolean {
  if (isListAmPage(html)) return false

  const lower = html.toLowerCase()

  if (lower.includes('<title>just a moment')) return true
  if (lower.includes('checking your browser before accessing')) return true
  if (lower.includes('cf-challenge-running')) return true
  if (lower.includes('id="challenge-form"')) return true
  if (lower.includes('id="challenge-stage"')) return true
  if (lower.includes('class="cf-turnstile"')) return true

  // Challenge pages are tiny; avoid matching CDN assets on real sites.
  if (html.length < 25_000 && lower.includes('verify you are human')) return true

  return false
}
