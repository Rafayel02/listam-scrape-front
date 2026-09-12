export interface ImagePhashEntry {
  url: string
  phash: string
}

export async function hashImageUrls(urls: string[]): Promise<ImagePhashEntry[]> {
  if (urls.length === 0) return []

  const res = await fetch('/api/dev/hash-images', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ urls }),
  })

  const data = (await res.json()) as {
    ok: boolean
    hashes?: ImagePhashEntry[]
    message?: string
  }

  if (!res.ok || !data.ok) {
    throw new Error(data.message ?? `Hash failed (${res.status})`)
  }

  return data.hashes ?? []
}
