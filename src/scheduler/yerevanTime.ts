export const YEREVAN_TIMEZONE = 'Asia/Yerevan'

export function formatYerevanDay(ms = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: YEREVAN_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(ms)
}

export function formatYerevanDateTime(ms = Date.now()): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: YEREVAN_TIMEZONE,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(ms)
}

/** Milliseconds until the next calendar day starts in Yerevan. */
export function msUntilNextYerevanMidnight(fromMs = Date.now()): number {
  const today = formatYerevanDay(fromMs)
  let probe = fromMs + 60_000

  while (formatYerevanDay(probe) === today) {
    probe += 60_000
  }

  let lo = fromMs
  let hi = probe
  while (hi - lo > 1_000) {
    const mid = Math.floor((lo + hi) / 2)
    if (formatYerevanDay(mid) === today) lo = mid
    else hi = mid
  }

  return Math.max(hi - fromMs, 1_000)
}

export function nextYerevanMidnightMs(fromMs = Date.now()): number {
  return fromMs + msUntilNextYerevanMidnight(fromMs)
}
