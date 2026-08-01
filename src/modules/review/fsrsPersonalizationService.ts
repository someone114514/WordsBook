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
  runtimeReason: FsrsRuntimeReason
  diagnostics: FsrsRuntimeDiagnostics
  active: boolean
  record?: FsrsPersonalizationRecord
}

export type FsrsRuntimeReason =
  | 'ready'
  | 'training-mode-required'
  | 'insecure-context'
  | 'shared-array-buffer-unavailable'
  | 'cross-origin-isolation-unavailable'

export interface FsrsRuntimeDiagnostics {
  available: boolean
  reason: FsrsRuntimeReason
  capabilityStage: 'ready' | 'blocked'
  workerStage: 'not-started' | 'starting' | 'ready' | 'failed'
  trainingMode: boolean
  secureContext: boolean
  crossOriginIsolated: boolean
  sharedArrayBuffer: boolean
  serviceWorkerControlled: boolean
  userAgent: string
  runtimeVersions: {
    binding: '0.5.0'
    napiWasmRuntime: '1.1.4'
    emnapi: '1.11.3'
  }
}

export type FsrsOptimizationPhase = 'preparing' | 'initializing' | 'training' | 'validating' | 'rebuilding' | 'saving'

export type FsrsErrorCode =
  | 'samples-insufficient'
  | 'runtime-unavailable'
  | 'runtime-version-mismatch'
  | 'worker-initialization-failed'
  | 'memory-pressure'
  | 'timeout'
  | 'validation-failed'
  | 'save-failed'
  | 'unknown'

export interface FsrsErrorInfo {
  code: FsrsErrorCode
  message: string
  technicalDetails: string
}

class FsrsOptimizationError extends Error {
  readonly code: FsrsErrorCode
  readonly technicalDetails: string

  constructor(
    code: FsrsErrorCode,
    message: string,
    technicalDetails: string,
  ) {
    super(message)
    this.name = 'FsrsOptimizationError'
    this.code = code
    this.technicalDetails = technicalDetails
  }
}

function failure(code: FsrsErrorCode, message: string, cause?: unknown): FsrsOptimizationError {
  const technicalDetails = cause instanceof Error
    ? `${cause.name}: ${cause.message}${cause.stack ? `\n${cause.stack}` : ''}`
    : cause === undefined ? message : String(cause)
  return new FsrsOptimizationError(code, message, technicalDetails)
}

export function describeFsrsError(reason: unknown): FsrsErrorInfo {
  if (reason instanceof FsrsOptimizationError) {
    return { code: reason.code, message: reason.message, technicalDetails: reason.technicalDetails }
  }
  const technicalDetails = reason instanceof Error
    ? `${reason.name}: ${reason.message}${reason.stack ? `\n${reason.stack}` : ''}`
    : String(reason)
  if (/napi_create_async_work|import function env:|emnapi|wasm-runtime/i.test(technicalDetails)) {
    return {
      code: 'runtime-version-mismatch',
      message: '训练组件版本不兼容。请更新应用后重新打开；当前记忆参数和复习进度不受影响。',
      technicalDetails,
    }
  }
  if (/out of memory|memory access|allocation failed|oom/i.test(technicalDetails)) {
    return {
      code: 'memory-pressure',
      message: '设备可用内存不足。请关闭其他页面后重试；当前参数会继续使用。',
      technicalDetails,
    }
  }
  if (/timeout|timed out/i.test(technicalDetails)) {
    return {
      code: 'timeout',
      message: '训练等待时间过长。请保持应用在前台并关闭其他页面后重试。',
      technicalDetails,
    }
  }
  return {
    code: 'unknown',
    message: '本次训练未完成。当前参数和复习进度均已保留，可以稍后重试。',
    technicalDetails,
  }
}

export interface FsrsOptimizationProgress {
  phase: FsrsOptimizationPhase
  current?: number
  total?: number
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

export interface FsrsOptimizationStats {
  effectiveReviewCount: number
  trainableItemCount: number
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

/** Lightweight eligibility count that avoids building cumulative review histories. */
export function summarizeFsrsOptimizationLogs(logs: ReviewLog[]): FsrsOptimizationStats {
  const seenDayByWord = new Set<string>()
  const countByWord = new Map<string, number>()
  for (const log of logs) {
    if (log.source === 'context') continue
    const studyDay = localDayKey(log.reviewedAt)
    if (!studyDay) continue
    const key = `${log.wordId}:${studyDay}`
    if (seenDayByWord.has(key)) continue
    seenDayByWord.add(key)
    countByWord.set(log.wordId, (countByWord.get(log.wordId) ?? 0) + 1)
  }
  return {
    effectiveReviewCount: seenDayByWord.size,
    trainableItemCount: [...countByWord.values()].reduce((total, count) => total + Math.max(0, count - 1), 0),
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

export function isFsrsTrainingMode(): boolean {
  if (typeof window === 'undefined') return false
  return new URL(window.location.href).searchParams.get('fsrs-training') === '1'
}

export function getFsrsRuntimeDiagnostics(): FsrsRuntimeDiagnostics {
  const trainingMode = isFsrsTrainingMode()
  const secureContext = typeof globalThis.isSecureContext === 'boolean' ? globalThis.isSecureContext : true
  const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated
  const sharedArrayBuffer = typeof SharedArrayBuffer !== 'undefined'
  const available = isolated && sharedArrayBuffer
  const reason: FsrsRuntimeReason = available
    ? 'ready'
    : !trainingMode
      ? 'training-mode-required'
      : !secureContext
        ? 'insecure-context'
        : !sharedArrayBuffer
          ? 'shared-array-buffer-unavailable'
          : 'cross-origin-isolation-unavailable'
  return {
    available,
    reason,
    capabilityStage: available ? 'ready' : 'blocked',
    workerStage: 'not-started',
    trainingMode,
    secureContext,
    crossOriginIsolated: isolated,
    sharedArrayBuffer,
    serviceWorkerControlled: typeof navigator !== 'undefined' && Boolean(navigator.serviceWorker?.controller),
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    runtimeVersions: {
      binding: '0.5.0',
      napiWasmRuntime: '1.1.4',
      emnapi: '1.11.3',
    },
  }
}

export async function initializePersonalizedReviewScheduler(): Promise<boolean> {
  const record = await loadRecord()
  return configureReviewScheduler(record?.activeParameters)
}

export async function getFsrsPersonalizationStatus(): Promise<FsrsPersonalizationStatus> {
  const [logs, record] = await Promise.all([db.reviewLogs.toArray(), loadRecord()])
  const stats = summarizeFsrsOptimizationLogs(logs)
  const diagnostics = getFsrsRuntimeDiagnostics()
  return {
    effectiveReviewCount: stats.effectiveReviewCount,
    trainableItemCount: stats.trainableItemCount,
    requiredReviewCount: FSRS_PERSONALIZATION_MIN_REVIEWS,
    eligible: stats.effectiveReviewCount >= FSRS_PERSONALIZATION_MIN_REVIEWS
      && stats.trainableItemCount >= MIN_HOLDOUT_ITEMS,
    runtimeAvailable: diagnostics.available,
    runtimeReason: diagnostics.reason,
    diagnostics,
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
  onProgress?: (progress: FsrsOptimizationProgress) => void,
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
    onProgress?.({ phase: 'rebuilding', current: index + 1, total: wordIds.length })
    if ((index + 1) % 25 === 0) await new Promise((resolve) => globalThis.setTimeout(resolve, 0))
  }
  return rebuilt
}

export async function optimizeFsrsParameters(
  onProgress?: (progress: FsrsOptimizationProgress) => void,
): Promise<FsrsPersonalizationRecord> {
  onProgress?.({ phase: 'preparing', current: 0, total: 1 })
  const logs = await db.reviewLogs.toArray()
  const dataset = buildFsrsOptimizationDataset(logs)
  onProgress?.({ phase: 'preparing', current: 1, total: 1 })
  if (dataset.effectiveReviewCount < FSRS_PERSONALIZATION_MIN_REVIEWS) {
    throw failure('samples-insufficient', `至少需要 ${FSRS_PERSONALIZATION_MIN_REVIEWS} 条有效的每日首次评分`)
  }
  if (dataset.items.length < MIN_HOLDOUT_ITEMS) {
    throw failure('samples-insufficient', '有效评分已足够，但跨日复习序列仍太少，暂时无法可靠训练')
  }
  const diagnostics = getFsrsRuntimeDiagnostics()
  if (!diagnostics.available) {
    throw failure('runtime-unavailable', diagnostics.reason === 'training-mode-required'
      ? '请先进入移动兼容训练模式'
      : '训练环境未成功启用浏览器隔离，请更新浏览器或重新进入训练模式')
  }

  onProgress?.({ phase: 'initializing', current: 0, total: 1 })
  const [
    { initOptimizer },
    { default: wasmUrl },
    { default: OptimizerWorker },
  ] = await Promise.all([
    import('@open-spaced-repetition/binding/dynamic-wasi'),
    import('../../assets/fsrs-binding.wasm32-wasi.wasm?url'),
    import('./fsrsOptimizerWorker?worker'),
  ])
  const optimizerWorkers: Worker[] = []
  let binding: Awaited<ReturnType<typeof initOptimizer>>
  try {
    binding = await initOptimizer({
      wasm: wasmUrl,
      worker: () => {
        const worker = new OptimizerWorker()
        optimizerWorkers.push(worker)
        return worker
      },
      errorEvent: true,
    })
    onProgress?.({ phase: 'initializing', current: 1, total: 1 })
  } catch (reason) {
    optimizerWorkers.forEach((worker) => worker.terminate())
    const mapped = describeFsrsError(reason)
    throw failure(
      mapped.code === 'runtime-version-mismatch' ? mapped.code : 'worker-initialization-failed',
      mapped.code === 'runtime-version-mismatch'
        ? mapped.message
        : '训练组件未能启动。请重新打开应用后重试；当前参数会继续使用。',
      reason,
    )
  }
  const makeItems = (definitions: FsrsItemDefinition[]) => definitions.map((definition) =>
    new binding.FSRSBindingItem(definition.reviews.map((review) =>
      new binding.FSRSBindingReview(review.rating, review.deltaT))),
  )
  const holdoutCount = Math.max(MIN_HOLDOUT_ITEMS, Math.ceil(dataset.items.length * HOLDOUT_FRACTION))
  const splitIndex = Math.max(1, dataset.items.length - holdoutCount)
  let holdoutSet: ReturnType<typeof makeItems> = []
  let parameters: number[]
  try {
    const trainSet = makeItems(dataset.items.slice(0, splitIndex))
    holdoutSet = makeItems(dataset.items.slice(splitIndex))
    parameters = await binding.computeParameters(trainSet, {
      enableShortTerm: false,
      numRelearningSteps: 0,
      timeout: 120,
      progress: (current, total) => onProgress?.({ phase: 'training', current, total }),
    })
  } catch (error) {
    const mapped = describeFsrsError(error)
    throw failure(mapped.code, mapped.message, error)
  } finally {
    optimizerWorkers.forEach((worker) => worker.terminate())
  }
  if (
    parameters.length !== DEFAULT_FSRS_PARAMETERS.length
    || parameters.some((parameter) => !Number.isFinite(parameter))
  ) {
    throw failure('validation-failed', '训练结果没有通过完整性检查，当前参数会继续使用。')
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('wordsbook:fsrs-optimizer-result', {
      detail: { parameterCount: parameters.length, allFinite: parameters.every(Number.isFinite) },
    }))
  }

  onProgress?.({ phase: 'validating', current: 0, total: 1 })
  const defaultMetrics = new binding.FSRSBinding(DEFAULT_FSRS_PARAMETERS).evaluate(holdoutSet)
  const candidateMetrics = new binding.FSRSBinding(parameters).evaluate(holdoutSet)
  onProgress?.({ phase: 'validating', current: 1, total: 1 })
  if (!metricsAreFinite(defaultMetrics) || !metricsAreFinite(candidateMetrics)) {
    throw failure('validation-failed', '训练结果没有通过留出集验证，当前参数会继续使用。')
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
    if (!configureReviewScheduler(parameters)) {
      throw failure('validation-failed', '训练结果无法安全应用，当前参数会继续使用。')
    }
    try {
      rebuiltStates = await rebuildReviewStates(dataset.canonicalLogsByWord, onProgress)
    } catch (error) {
      configureReviewScheduler(previous?.activeParameters)
      throw error
    }
  }

  const now = record.trainedAt!
  onProgress?.({ phase: 'saving', current: 0, total: 1 })
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
    throw failure('save-failed', '训练已完成，但保存失败。当前参数和复习状态没有改变，请稍后重试。', error)
  }
  if (activate) {
    invalidateStudyPlanCache()
    await markStudyDataChanged()
  }
  onProgress?.({ phase: 'saving', current: 1, total: 1 })
  return record
}
