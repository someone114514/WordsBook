export const MAX_READING_BATCH_SIZE = 12
export const TARGET_READING_BATCH_SIZE = 10
export const READING_BATCH_PLAN_VERSION = 2

function uniqueWordIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter(
    (wordId): wordId is string => typeof wordId === 'string' && wordId.trim().length > 0,
  ))]
}

export function parseReadingBatchesJson(raw: string | undefined): string[][] {
  if (!raw) return []
  try {
    const value = JSON.parse(raw) as unknown
    if (!Array.isArray(value)) return []
    return value
      .map((batch) => uniqueWordIds(batch))
      .filter((batch) => batch.length > 0)
  } catch {
    return []
  }
}

/**
 * Reading capacity is independent from card-unit capacity. Adjacent small
 * units are combined whole so an all-new 5 + 5 plan becomes one 10-word
 * article without increasing the number of new cards introduced at once.
 */
export function buildUnitReadingBatches(raw: string | undefined): string[][] {
  if (!raw) return []
  try {
    const value = JSON.parse(raw) as unknown
    if (!Array.isArray(value)) return []
    const unitWords = value
      .map((unit) => unit && typeof unit === 'object'
        ? uniqueWordIds((unit as { wordIds?: unknown }).wordIds)
        : [])
      .filter((words) => words.length > 0)
    const batches: string[][] = []
    const seen = new Set<string>()
    let current: string[] = []

    const flush = () => {
      if (current.length) batches.push(current)
      current = []
    }

    for (const sourceWords of unitWords) {
      const words = sourceWords.filter((wordId) => !seen.has(wordId))
      words.forEach((wordId) => seen.add(wordId))
      if (!words.length) continue

      if (words.length > MAX_READING_BATCH_SIZE) {
        flush()
        for (let offset = 0; offset < words.length; offset += MAX_READING_BATCH_SIZE) {
          batches.push(words.slice(offset, offset + MAX_READING_BATCH_SIZE))
        }
        continue
      }

      if (current.length && current.length + words.length > MAX_READING_BATCH_SIZE) flush()
      current.push(...words)
      if (current.length >= TARGET_READING_BATCH_SIZE) flush()
    }
    flush()
    return batches
  } catch {
    return []
  }
}

export function findReadingBatchForUnit(
  batches: string[][],
  unitWordIds: string[],
  afterBatchIndex = -1,
): number {
  const words = new Set(unitWordIds)
  const intersects = (batch: string[]) => batch.some((wordId) => words.has(wordId))
  const later = batches.findIndex((batch, index) => index > afterBatchIndex && intersects(batch))
  if (later >= 0) return later
  const any = batches.findIndex(intersects)
  return any >= 0 ? any : Math.max(0, Math.min(afterBatchIndex, Math.max(0, batches.length - 1)))
}

export interface RecoveryReadingBatch {
  sourceIndex: number
  wordIds: string[]
}

export function extractRecoveryReadingBatches(batches: string[][]): RecoveryReadingBatch[] {
  const seen = new Set<string>()
  const recovery: RecoveryReadingBatch[] = []
  batches.forEach((batch, sourceIndex) => {
    if (batch.length > 0 && batch.every((wordId) => seen.has(wordId))) {
      recovery.push({ sourceIndex, wordIds: [...batch] })
    }
    batch.forEach((wordId) => seen.add(wordId))
  })
  return recovery
}

/**
 * Unit membership may change while an omitted-word recovery is waiting.
 * Rebuild the baseline capacity plan, then reattach each duplicate-only
 * recovery immediately after the baseline batch that introduced its words.
 */
export function mergeReadingPlanWithRecovery(
  planned: string[][],
  cached: string[][],
): string[][] {
  const recovery = extractRecoveryReadingBatches(cached)
  if (!recovery.length) return planned
  const byAnchor = new Map<number, string[][]>()
  for (const row of recovery) {
    const words = new Set(row.wordIds)
    const anchor = planned.findIndex((batch) => batch.some((wordId) => words.has(wordId)))
    if (anchor < 0) continue
    const rows = byAnchor.get(anchor) ?? []
    rows.push(row.wordIds)
    byAnchor.set(anchor, rows)
  }
  return planned.flatMap((batch, index) => [batch, ...(byAnchor.get(index) ?? [])])
}
