import type { Listing, PriceHistoryEntry } from '../types'

export type FieldChange = { field: string; from: unknown; to: unknown }

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null && b == null) return true
  return JSON.stringify(a) === JSON.stringify(b)
}

function diffRecord(
  prefix: string,
  before?: Record<string, string>,
  after?: Record<string, string>,
): FieldChange[] {
  const changes: FieldChange[] = []
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])

  for (const key of keys) {
    const from = before?.[key]
    const to = after?.[key]
    if (!valuesEqual(from, to)) {
      changes.push({ field: `${prefix}.${key}`, from, to })
    }
  }

  return changes
}

function diffStringArray(prefix: string, before?: string[], after?: string[]): FieldChange[] {
  const b = before ?? []
  const a = after ?? []
  if (valuesEqual(b, a)) return []

  const changes: FieldChange[] = []
  const beforeSet = new Set(b)
  const afterSet = new Set(a)

  for (const item of b) {
    if (!afterSet.has(item)) {
      changes.push({ field: `${prefix}[]`, from: item, to: undefined })
    }
  }
  for (const item of a) {
    if (!beforeSet.has(item)) {
      changes.push({ field: `${prefix}[]`, from: undefined, to: item })
    }
  }

  if (changes.length === 0) {
    for (let i = 0; i < Math.max(b.length, a.length); i++) {
      if (b[i] !== a[i]) {
        changes.push({ field: `${prefix}[${i}]`, from: b[i], to: a[i] })
      }
    }
  }

  return changes
}

function summarizePriceEntry(entry?: PriceHistoryEntry): string | undefined {
  if (!entry) return undefined
  const parts = [
    entry.date,
    entry.price != null ? String(entry.price) : undefined,
    entry.currency,
  ].filter(Boolean)
  return parts.join(' · ') || entry.raw || undefined
}

function diffPriceHistory(
  prefix: string,
  before?: PriceHistoryEntry[],
  after?: PriceHistoryEntry[],
): FieldChange[] {
  const b = before ?? []
  const a = after ?? []
  if (valuesEqual(b, a)) return []

  const changes: FieldChange[] = []
  const maxLen = Math.max(b.length, a.length)

  for (let i = 0; i < maxLen; i++) {
    if (valuesEqual(b[i], a[i])) continue
    const label = b[i]?.date ?? a[i]?.date ?? String(i + 1)
    changes.push({
      field: `${prefix}[${label}]`,
      from: summarizePriceEntry(b[i]),
      to: summarizePriceEntry(a[i]),
    })
  }

  return changes
}

function diffExtras(
  prefix: string,
  before?: Record<string, unknown>,
  after?: Record<string, unknown>,
): FieldChange[] {
  const changes: FieldChange[] = []
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])

  for (const key of keys) {
    const from = before?.[key]
    const to = after?.[key]
    if (!valuesEqual(from, to)) {
      changes.push({ field: `${prefix}.${key}`, from, to })
    }
  }

  return changes
}

export function diffListingFields(
  before: Partial<Listing>,
  after: Partial<Listing>,
  fields: (keyof Listing)[],
): FieldChange[] {
  const changes: FieldChange[] = []

  for (const field of fields) {
    if (!(field in after)) continue
    const from = before[field]
    const to = after[field]
    if (valuesEqual(from, to)) continue

    switch (field) {
      case 'attributes':
        changes.push(
          ...diffRecord('attributes', from as Record<string, string>, to as Record<string, string>),
        )
        break
      case 'imageUrls':
      case 'badges':
        changes.push(...diffStringArray(field, from as string[], to as string[]))
        break
      case 'sourcePriceHistory':
        changes.push(
          ...diffPriceHistory(
            'sourcePriceHistory',
            from as PriceHistoryEntry[],
            to as PriceHistoryEntry[],
          ),
        )
        break
      case 'cardExtras':
      case 'detailExtras':
        changes.push(
          ...diffExtras(field, from as Record<string, unknown>, to as Record<string, unknown>),
        )
        break
      default:
        changes.push({ field, from, to })
    }
  }

  return changes
}

export function formatChangeValue(value: unknown): string {
  if (value === undefined) return '—'
  if (value === null) return 'null'
  if (typeof value === 'string') {
    return value.length > 100 ? `${value.slice(0, 97)}…` : value
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    if (value.every((item) => typeof item === 'string')) {
      return value.length === 1 ? value[0] : `${value.length} items`
    }
    return `[${value.length} items]`
  }
  if (typeof value === 'object') {
    const json = JSON.stringify(value)
    return json.length > 100 ? `${json.slice(0, 97)}…` : json
  }
  return String(value)
}
