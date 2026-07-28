import { db } from '../../db/database'
import type { ReviewLog, ReviewState } from '../../types/models'
import { markRecordChanged } from '../sync/localSyncStore'
import { markStudyDataChanged } from './studyDataRevision'
import { invalidateStudyPlanCache } from './reviewService'
import {
  configureReviewScheduler,
  DEFAULT_FSRS_PARAMETERS,
  normalizeReviewRating,
  replayReviewState,
} from './scheduler'

export const FSRS_PERSONALIZATION_MIN_REVIEWS = 400
const FSRS_PERSONALIZATION_KEY = 'fsrsPersonalization'
const HOLDOUT_FRACTION = 0.2
const MIN_HOLDOUT_ITEMS = 40

export interface FsrsEvaluationMetrics {
  logLoss: number
  rmseBins: number
}

export interface FsrsPersonalizationRecord {
  schemaVersion: 1
  effectiveReviewCount: number
  trainedAt?: string
  activeParameters?: number[]
  defaultMetrics?: FsrsEvaluationMetrics
  candidateMetrics?: FsrsEvaluationMetrics
  lastOutcome?: 'active' | 'rejected'
}

export interface FsrsPersonalizationStatus {
  effectiveReviewCount: number
  trainableItemCount: number
  requiredReviewCount: number
  eligible: boolean
  runtimeAvailable: boolean
  active: boolean
  record?: FsrsPersonalizationRecord
}

export interface FsrsReviewDefinition {
  rating: 1 | 2 | 3 | 4
  deltaT: number
}

export interface FsrsItemDefinition {
  wordId: string
  reviewedAt: string
  reviews: FsrsReviewDefinition[]
}

export interface FsrsOptimizationDataset {
  effectiveReviewCount: number
  items: FsrsItemDefinition[]
  canonicalLogsByWord: Map<string, ReviewLog[]>
}

function ratingNumber(log: ReviewLog): 1 | 2 | 3 | 4 {
  const rating = normalizeReviewRating(log.rating)
  return rating === 'again' ? 1 : rating === 'hard' ? 2 : rating === 'good' ? 3 : 4
}

function localDayKey(value: string): string | undefined {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return undefined
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}

function calendarDayDifference(previous: string, current: string): number {
  const before = new Date(previous)
  const after = new Date(current)
  const beforeDay = new Date(before.getFullYear(), before.getMonth(), before.getDate())
  const afterDay = new Date(after.getFullYear(), after.getMonth(), after.getDate())
  return Math.max(0, Math.round((afterDay.getTime() - beforeDay.getTime()) / 86_400_000))
}

/**
 * Keeps only the first valid long-term grade for each word and local study day.
 * Context-only and duplicate same-day evidence must never train the FSRS model.
 */
export function buildFsrsOptimizationDataset(logs: ReviewLog[]): FsrsOptimizationDataset {
  const accepted = logs
    .filter((log) => log.source !== 'context' && localDayKey(log.reviewedAt))
    .sort((left, right) => left.reviewedAt.localeCompare(right.reviewedAt))
  const canonicalLogsByWord = new Map<string, ReviewLog[]>()
  const seenDayByWord = new Set<string>()
  for (const log of accepted) {
    const studyDay = localDayKey(log.reviewedAt)
    if (!studyDay) continue
    const key = `${log.wordId}:${studyDay}`
    if (seenDayByWord.has(key)) continue
    seenDayByWord.add(key)
    const bucket = canonicalLogsByWord.get(log.wordId) ?? []
    bucket.push(log)
    canonicalLogsByWord.set(log.wordId, bucket)
  }

  const items: FsrsItemDefinition[] = []
  for (const [wordId, wordLogs] of canonicalLogsByWord) {
    const reviews: FsrsReviewDefinition[] = []
    for (const [index, log] of wordLogs.entries()) {
      reviews.push({
        rating: ratingNumber(log),
        deltaT: index === 0 ? 0 : calendarDayDifference(wordLogs[index - 1]!.reviewedAt, log.reviewedAt),
      })
      if (index > 0) {
        items.push({
          wordId,
          reviewedAt: log.reviewedAt,
          reviews: reviews.map((review) => ({ ...review })),
        })
      }
    }
  }
  items.sort((left, right) => left.reviewedAt.localeCompare(right.reviewedAt))
  return {
    effectiveReviewCount: [...canonicalLogsByWord.values()].reduce((total, wordLogs) => total + wordLogs.length, 0),
    items,
    canonicalLogsByWord,
  }
}

function parseRecord(value: unknown): FsrsPersonalizationRecord | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Partial<FsrsPersonalizationRecord>
  if (candidate.schemaVersion !== 1 || typeof candidate.effectiveReviewCount !== 'number') return undefined
  const parameters = candidate.activeParameters
  if (parameters && (
    parameters.length !== DEFAULT_FSRS_PARAMETERS.length
    || parameters.some((parameter) => !Number.isFinite(parameter))
  )) return undefined
  return candidate as FsrsPersonalizationRecord
}

async function loadRecord(): Promise<FsrsPersonalizationRecord | undefined> {
  return parseRecord((await db.settings.get(FSRS_PERSONALIZATION_KEY))?.value)
}

function optimizerRuntimeAvailable(): boolean {
  return typeof SharedArrayBuffer !== 'undefined'
    && typeof crossOriginIsolated !== 'undefined'
    && crossOriginIsolated
}

export async function initializePersonalizedReviewScheduler(): Promise<boolean> {
  const record = await loadRecord()
  return configureReviewScheduler(record?.activeParameters)
}

export async function getFsrsPersonalizationStatus(): Promise<FsrsPersonalizationStatus> {
  const [logs, record] = await Promise.all([db.reviewLogs.toArray(), loadRecord()])
  const dataset = buildFsrsOptimizationDataset(logs)
  return {
    effectiveReviewCount: dataset.effectiveReviewCount,
    trainableItemCount: dataset.items.length,
    requiredReviewCount: FSRS_PERSONALIZATION_MIN_REVIEWS,
    eligible: dataset.effectiveReviewCount >= FSRS_PERSONALIZATION_MIN_REVIEWS
      && dataset.items.length >= MIN_HOLDOUT_ITEMS,
    runtimeAvailable: optimizerRuntimeAvailable(),
    active: Boolean(record?.activeParameters),
    record,
  }
}

function metricsAreFinite(metrics: FsrsEvaluationMetrics): boolean {
  return Number.isFinite(metrics.logLoss) && Number.isFinite(metrics.rmseBins)
}

function candidateIsBetter(
  baseline: FsrsEvaluationMetrics,
  candidate: FsrsEvaluationMetrics,
): boolean {
  const epsilon = 1e-6
  return candidate.logLoss < baseline.logLoss - epsilon
    && candidate.rmseBins < baseline.rmseBins - epsilon
}

async function rebuildReviewStates(
  canonicalLogsByWord: Map<string, ReviewLog[]>,
): Promise<ReviewState[]> {
  const wordIds = [...canonicalLogsByWord.keys()]
  const [states, words] = await Promise.all([
    db.reviewState.bulkGet(wordIds),
    db.wordbook.bulkGet(wordIds),
  ])
  const rebuilt: ReviewState[] = []
  for (const [index, wordId] of wordIds.entries()) {
    const state = states[index]
    const word = words[index]
    const logs = canonicalLogsByWord.get(wordId)
    if (!state || !word || !logs?.length) continue
    rebuilt.push(replayReviewState(state, logs, word.addedAt))
  }
  return rebuilt
}

export async function optimizeFsrsParameters(
  onProgress?: (current: number, total: number) => void,
): Promise<FsrsPersonalizationRecord> {
  const logs = await db.reviewLogs.toArray()
  const dataset = buildFsrsOptimizationDataset(logs)
  if (dataset.effectiveReviewCount < FSRS_PERSONALIZATION_MIN_REVIEWS) {
    throw new Error(`至少需要 ${FSRS_PERSONALIZATION_MIN_REVIEWS} 条有效的每日首次评分`)
  }
  if (dataset.items.length < MIN_HOLDOUT_ITEMS) {
    throw new Error('有效评分已足够，但跨日复习序列仍太少，暂时无法可靠训练')
  }
  if (!optimizerRuntimeAvailable()) {
    throw new Error('当前部署未启用浏览器隔离，无法安全运行本地 FSRS 优化器')
  }

  const [
    { initOptimizer },
    { default: wasmUrl },
    { default: OptimizerWorker },
  ] = await Promise.all([
    import('@open-spaced-repetition/binding/dynamic-wasi'),
    import('../../assets/fsrs-binding.wasm32-wasi.wasm?url'),
    import('./fsrsOptimizerWorker?worker'),
  ])
  const binding = await initOptimizer({
    wasm: wasmUrl,
    worker: () => new OptimizerWorker(),
    errorEvent: true,
  })
  const makeItems = (definitions: FsrsItemDefinition[]) => definitions.map((definition) =>
    new binding.FSRSBindingItem(definition.reviews.map((review) =>
      new binding.FSRSBindingReview(review.rating, review.deltaT))),
  )
  const holdoutCount = Math.max(MIN_HOLDOUT_ITEMS, Math.ceil(dataset.items.length * HOLDOUT_FRACTION))
  const splitIndex = Math.max(1, dataset.items.length - holdoutCount)
  const trainSet = makeItems(dataset.items.slice(0, splitIndex))
  const holdoutSet = makeItems(dataset.items.slice(splitIndex))
  const parameters = await binding.computeParameters(trainSet, {
    enableShortTerm: false,
    numRelearningSteps: 0,
    timeout: 120,
    progress: (current, total) => onProgress?.(current, total),
  })
  if (
    parameters.length !== DEFAULT_FSRS_PARAMETERS.length
    || parameters.some((parameter) => !Number.isFinite(parameter))
  ) {
    throw new Error('FSRS 优化器返回了不兼容的参数')
  }

  const defaultMetrics = new binding.FSRSBinding(DEFAULT_FSRS_PARAMETERS).evaluate(holdoutSet)
  const candidateMetrics = new binding.FSRSBinding(parameters).evaluate(holdoutSet)
  if (!metricsAreFinite(defaultMetrics) || !metricsAreFinite(candidateMetrics)) {
    throw new Error('FSRS 留出集评估结果无效')
  }
  const previous = await loadRecord()
  const activate = candidateIsBetter(defaultMetrics, candidateMetrics)
  const record: FsrsPersonalizationRecord = {
    schemaVersion: 1,
    effectiveReviewCount: dataset.effectiveReviewCount,
    trainedAt: new Date().toISOString(),
    activeParameters: activate ? [...parameters] : previous?.activeParameters,
    defaultMetrics: { ...defaultMetrics },
    candidateMetrics: { ...candidateMetrics },
    lastOutcome: activate ? 'active' : 'rejected',
  }

  let rebuiltStates: ReviewState[] = []
  if (activate) {
    if (!configureReviewScheduler(parameters)) throw new Error('FSRS 参数无法应用到调度器')
    try {
      rebuiltStates = await rebuildReviewStates(dataset.canonicalLogsByWord)
    } catch (error) {
      configureReviewScheduler(previous?.activeParameters)
      throw error
    }
  }

  const now = record.trainedAt!
  try {
    await db.transaction('rw', [db.settings, db.reviewState, db.syncMeta, db.syncRecords, db.syncTombstones], async () => {
      await db.settings.put({ key: FSRS_PERSONALIZATION_KEY, value: record })
      await markRecordChanged('settings', FSRS_PERSONALIZATION_KEY, now)
      if (rebuiltStates.length) {
        await db.reviewState.bulkPut(rebuiltStates)
        for (const state of rebuiltStates) await markRecordChanged('reviewState', state.wordId, now)
      }
    })
  } catch (error) {
    if (activate) configureReviewScheduler(previous?.activeParameters)
    throw error
  }
  if (activate) {
    invalidateStudyPlanCache()
    await markStudyDataChanged()
  }
  return record
}
