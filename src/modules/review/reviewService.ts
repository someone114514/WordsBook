import dayjs from 'dayjs'
import { db } from '../../db/database'
import type {
  ReviewCard,
  ReviewLog,
  ReviewRating,
  ReviewState,
  StudyPlan,
  WordbookItem,
} from '../../types/models'
import { dictionaryEntryFromWordbook, repairVocabularyIntegrity } from '../wordbook/vocabularyIntegrity'
import { applyAiOverrides } from '../dictionary/entryOverrideMapper'
import { loadSettings } from '../settings/settingsService'
import { markPayloadChanged, markRecordChanged } from '../sync/localSyncStore'
import { getStudyDataRevision, getStudyQueueRevision, markStudyDataChanged } from './studyDataRevision'
import {
  cardToReviewState,
  formatInterval,
  migrateLegacyReviewState,
  previewFsrsReviews,
  scheduleFsrsReview,
  getReviewRetrievability,
  isFsrsReviewState,
} from './scheduler'

interface BuildPlanOptions {
  at?: Date
  dailyNewLimit?: number
  dailyReviewLimit?: number
  listIds?: string[]
  excludeWordIds?: string[]
  includeImportBacklog?: boolean
  promoteImportBacklog?: boolean
  allowRecoveryNewWords?: boolean
}

interface PlanCache {
  plan: StudyPlan
  revision: string
  dailyNewLimit: number
  dailyReviewLimit: number
  dayKey: string
  nextDueAt?: string
  stale?: boolean
}

let planCache: PlanCache | null = null

type StudyWordbookRow = {
  word: WordbookItem
  listIds: string[]
  sourcePriority: number
  joinedAt: string
  learningEnabled: boolean
  membershipIds: string[]
}

let studyRowsCache: { key: string; revision: string; rows: StudyWordbookRow[] } | null = null

type ActiveStateRow = {
  wordId: string
  headword: string
  state: ReviewState
  listIds: string[]
  sourcePriority: number
  joinedAt: string
  learningEnabled: boolean
  membershipIds: string[]
}

const SOURCE_PRIORITY = {
  lookup: 5,
  article: 4,
  manual: 3,
  import: 2,
  migration: 1,
} as const

function interleaveRecoveryRows<T extends { wordId: string; state: ReviewState }>(
  rows: T[],
  at: Date,
): T[] {
  const risk = [...rows]
  const oldest = [...rows].sort((left, right) => left.state.nextReviewAt.localeCompare(right.state.nextReviewAt))
  const easier = [...rows].sort((left, right) =>
    getReviewRetrievability(right.state, at) - getReviewRetrievability(left.state, at))
  const used = new Set<string>()
  const output: T[] = []
  const take = (source: T[], count: number) => {
    for (const row of source) {
      if (used.has(row.wordId)) continue
      used.add(row.wordId)
      output.push(row)
      if (--count === 0) break
    }
  }
  while (output.length < rows.length) {
    const before = output.length
    take(risk, 5)
    take(oldest, 3)
    take(easier, 2)
    if (output.length === before) break
  }
  return output
}

function normalizedInitial(value: string | undefined): string {
  return (value ?? '').replace(/^[^a-z]+/i, '').charAt(0).toLowerCase()
}

export async function avoidAdjacentWordInitials(wordIds: string[], knownHeadwords?: Map<string, string>): Promise<string[]> {
  if (wordIds.length < 2) return [...wordIds]
  const initials = knownHeadwords
    ? new Map(wordIds.map((wordId) => [wordId, normalizedInitial(knownHeadwords.get(wordId))]))
    : new Map((await db.wordbook.bulkGet(wordIds)).flatMap((word) => word
        ? [[word.wordId, normalizedInitial(word.headwordLower ?? word.headword)] as const]
        : []))
  const buckets = new Map<string, string[]>()
  const rank = new Map(wordIds.map((wordId, index) => [wordId, index]))
  for (const wordId of wordIds) {
    const initial = initials.get(wordId) || `:${wordId}`
    const bucket = buckets.get(initial) ?? []
    bucket.push(wordId)
    buckets.set(initial, bucket)
  }
  const arranged: string[] = []
  while (arranged.length < wordIds.length) {
    const previousInitial = initials.get(arranged[arranged.length - 1] ?? '')
    const candidates = [...buckets.entries()]
      .filter(([, bucket]) => bucket.length > 0)
      .sort((left, right) => (rank.get(left[1][0]!) ?? 0) - (rank.get(right[1][0]!) ?? 0))
    const selected = candidates.find(([initial]) => initial !== previousInitial) ?? candidates[0]
    if (!selected) break
    arranged.push(selected[1].shift()!)
  }
  return arranged
}

async function getStudyWordbookRows(listIds?: string[], includeImportBacklog = false): Promise<StudyWordbookRow[]> {
  const revision = await getStudyQueueRevision()
  const cacheKey = `${[...(listIds ?? [])].sort().join(',')}|${includeImportBacklog ? 1 : 0}`
  if (studyRowsCache?.key === cacheKey && studyRowsCache.revision === revision) return studyRowsCache.rows
  const enabledLists = listIds?.length
    ? await db.studyLists.where('listId').anyOf(listIds).toArray()
    : await db.studyLists.where('studyEnabled').equals(1).toArray()
  const activeListIds = enabledLists
    .filter((list) => list.studyEnabled === 1 || Boolean(listIds?.includes(list.listId)))
    .map((list) => list.listId)
  if (activeListIds.length === 0) return []
  const memberships = (await db.studyListItems.where('listId').anyOf(activeListIds).toArray())
    .filter((membership) => membership.learningEnabled !== 0 || (includeImportBacklog && membership.autoActivate === 1))
  const membershipMap = new Map<string, typeof memberships>()
  for (const membership of memberships) {
    const bucket = membershipMap.get(membership.wordId) ?? []
    bucket.push(membership)
    membershipMap.set(membership.wordId, bucket)
  }
  const wordIds = [...membershipMap.keys()]
  const words = await db.wordbook.bulkGet(wordIds)
  const rows = words
    .filter((row): row is WordbookItem => Boolean(row && row.archived === 0 && row.integrityStatus !== 'needs-repair'))
    .map((word) => {
      const rows = membershipMap.get(word.wordId) ?? []
      return {
        word,
        listIds: rows.map((row) => row.listId),
        sourcePriority: Math.max(...rows.map((row) => SOURCE_PRIORITY[row.source ?? 'migration']), 0),
        joinedAt: rows.map((row) => row.addedAt).sort().slice(-1)[0] ?? word.addedAt,
        learningEnabled: rows.some((row) => row.learningEnabled !== 0),
        membershipIds: rows.map((row) => row.membershipId),
      }
    })
  studyRowsCache = { key: cacheKey, revision, rows }
  return rows
}

async function getActiveStateRows(listIds?: string[], includeImportBacklog = false): Promise<ActiveStateRow[]> {
  const wordbookRows = await getStudyWordbookRows(listIds, includeImportBacklog)
  const stateRows = await db.reviewState.bulkGet(wordbookRows.map((row) => row.word.wordId))
  const stateMap = new Map(
    stateRows
      .filter((state): state is NonNullable<typeof state> => state !== undefined)
      .map((state) => [state.wordId, state]),
  )
  const missingStates: ReviewState[] = []
  const activeRows: ActiveStateRow[] = []

  for (const wordbookRow of wordbookRows) {
    const existingState = stateMap.get(wordbookRow.word.wordId)
    if (existingState) {
      activeRows.push({ wordId: wordbookRow.word.wordId, headword: wordbookRow.word.headwordLower ?? wordbookRow.word.headword ?? '', state: existingState, listIds: wordbookRow.listIds, sourcePriority: wordbookRow.sourcePriority, joinedAt: wordbookRow.joinedAt, learningEnabled: wordbookRow.learningEnabled, membershipIds: wordbookRow.membershipIds })
      continue
    }

    const fallbackState: ReviewState = {
      wordId: wordbookRow.word.wordId,
      cycle: 0,
      nextReviewAt: wordbookRow.word.addedAt,
      successCount: 0,
      lapseCount: 0,
      totalReviews: 0,
    }
    missingStates.push(fallbackState)
    activeRows.push({ wordId: wordbookRow.word.wordId, headword: wordbookRow.word.headwordLower ?? wordbookRow.word.headword ?? '', state: fallbackState, listIds: wordbookRow.listIds, sourcePriority: wordbookRow.sourcePriority, joinedAt: wordbookRow.joinedAt, learningEnabled: wordbookRow.learningEnabled, membershipIds: wordbookRow.membershipIds })
  }

  if (missingStates.length > 0) {
    await db.reviewState.bulkPut(missingStates)
  }

  const legacyRows = activeRows.filter((row) => !isFsrsReviewState(row.state))
  if (legacyRows.length > 0) {
    const legacyIds = new Set(legacyRows.map((row) => row.wordId))
    const logs = legacyIds.size ? await db.reviewLogs.where('wordId').anyOf([...legacyIds]).toArray() : []
    const logsByWord = new Map<string, typeof logs>()
    for (const log of logs) {
      const bucket = logsByWord.get(log.wordId) ?? []
      bucket.push(log)
      logsByWord.set(log.wordId, bucket)
    }
    const addedAt = new Map(wordbookRows.map((row) => [row.word.wordId, row.word.addedAt]))
    for (const row of legacyRows) {
      row.state = migrateLegacyReviewState(
        row.state,
        logsByWord.get(row.wordId) ?? [],
        addedAt.get(row.wordId) ?? row.state.nextReviewAt,
      )
    }
    await db.reviewState.bulkPut(legacyRows.map((row) => row.state))
  }

  return activeRows
}

export async function buildTodayPlan(options: BuildPlanOptions = {}): Promise<StudyPlan> {
  const requiresSettings =
    options.dailyNewLimit === undefined || options.dailyReviewLimit === undefined
  const settings = requiresSettings ? await loadSettings() : null
  const now = options.at ?? new Date()
  const nowIso = now.toISOString()

  const dailyNewLimit = Math.max(0, Math.floor(options.dailyNewLimit ?? settings?.dailyNewLimit ?? 20))
  const dailyReviewLimit = Math.max(
    0,
    Math.floor(options.dailyReviewLimit ?? settings?.dailyReviewLimit ?? 200),
  )

  const excludedWordIds = new Set(options.excludeWordIds ?? [])
  const rows = (await getActiveStateRows(options.listIds, options.includeImportBacklog ?? true))
    .filter((row) => !excludedWordIds.has(row.wordId))

  const sortedDueRows = rows
    .filter((row) => {
      if (row.state.suspendedAt) return false
      const manualRelearnDue = row.state.sameDayRelearnAt
        && !dayjs(row.state.sameDayRelearnAt).isAfter(nowIso)
      return Boolean(manualRelearnDue)
        || ((row.state.reps ?? row.state.totalReviews) > 0 && !dayjs(row.state.nextReviewAt).isAfter(nowIso))
    })
    .sort((left, right) => {
      const manualPriority = Number(Boolean(right.state.sameDayRelearnAt))
        - Number(Boolean(left.state.sameDayRelearnAt))
      if (manualPriority) return manualPriority
      const retrievabilityDiff = getReviewRetrievability(left.state, now) - getReviewRetrievability(right.state, now)
      if (Math.abs(retrievabilityDiff) > 1e-6) return retrievabilityDiff
      return left.state.nextReviewAt.localeCompare(right.state.nextReviewAt)
    })
  const todayKey = dayjs(now).format('YYYY-MM-DD')
  const previousSession = await db.dailyLearningSessions
    .where('dayKey')
    .below(todayKey)
    .reverse()
    .first()
  const daysSinceLastStudy = previousSession
    ? Math.max(0, dayjs(now).startOf('day').diff(previousSession.dayKey, 'day'))
    : 0
  const recoveryMode = daysSinceLastStudy >= 2
    || (dailyReviewLimit > 0 && sortedDueRows.length > dailyReviewLimit)
  const dueRows = recoveryMode ? interleaveRecoveryRows(sortedDueRows, now) : sortedDueRows

  const newRows = rows
    .filter((row) => !row.state.suspendedAt && (row.state.reps ?? row.state.totalReviews) === 0)
    .sort((left, right) => Number(right.learningEnabled) - Number(left.learningEnabled)
      || right.sourcePriority - left.sourcePriority
      || right.joinedAt.localeCompare(left.joinedAt)
      || left.state.nextReviewAt.localeCompare(right.state.nextReviewAt))

  const selectedDue = dueRows.slice(0, dailyReviewLimit)
  const effectiveNewLimit = recoveryMode && !options.allowRecoveryNewWords
    ? 0
    : dueRows.length > dailyReviewLimit
    ? 0
    : dueRows.length > dailyReviewLimit * 0.5
      ? Math.ceil(dailyNewLimit / 2)
      : dailyNewLimit
  const enabledListIds = [...new Set(rows.flatMap((row) => row.listIds))]
  const selectedNew = newRows.slice(0, effectiveNewLimit)

  const promotedMembershipIds = [...new Set(selectedNew.filter((row) => !row.learningEnabled).flatMap((row) => row.membershipIds))]
  if (promotedMembershipIds.length && (options.promoteImportBacklog ?? true)) {
    const memberships = await db.studyListItems.bulkGet(promotedMembershipIds)
    const now = new Date().toISOString()
    const promoted = memberships.flatMap((membership) => membership ? [{ ...membership, learningEnabled: 1 as const, autoActivate: 0 as const }] : [])
    await db.studyListItems.bulkPut(promoted)
    for (const membership of promoted) await markPayloadChanged('studyListItems', membership, now)
    await markStudyDataChanged()
  }

  const selectedRows: typeof rows = []
  let dueIndex = 0
  let newIndex = 0
  const selectedTotal = selectedDue.length + selectedNew.length
  while (selectedRows.length < selectedTotal) {
    const desiredNewCount = Math.round((selectedRows.length + 1) * selectedNew.length / selectedTotal)
    if (newIndex < desiredNewCount && selectedNew[newIndex]) selectedRows.push(selectedNew[newIndex++]!)
    else if (selectedDue[dueIndex]) selectedRows.push(selectedDue[dueIndex++]!)
    else if (selectedNew[newIndex]) selectedRows.push(selectedNew[newIndex++]!)
  }
  const activeLists = await db.studyLists.bulkGet(enabledListIds)
  const listContributions = activeLists.flatMap((list, index) => list ? [{
    listId: enabledListIds[index]!,
    name: list.name,
    count: selectedRows.filter((row) => row.listIds.includes(enabledListIds[index]!)).length,
  }] : [])
  const headwords = new Map(rows.map((row) => [row.wordId, row.headword]))
  const queueWordIds = await avoidAdjacentWordInitials(selectedRows.map((row) => row.wordId), headwords)
  const eligibleWordIds = await avoidAdjacentWordInitials([...dueRows, ...newRows].map((row) => row.wordId), headwords)
  const endOfDay = dayjs(now).add(1, 'day').startOf('day')
  const laterToday = rows
    .filter((row) => !row.state.suspendedAt
      && (row.state.reps ?? row.state.totalReviews) > 0
      && dayjs(row.state.nextReviewAt).isAfter(nowIso)
      && dayjs(row.state.nextReviewAt).isBefore(endOfDay))
    .sort((left, right) => left.state.nextReviewAt.localeCompare(right.state.nextReviewAt))
  return {
    // These counts describe the actual queue, not the entire backlog. This keeps
    // the headline total equal to "复习 + 新词" and makes the configured limits visible.
    dueCount: selectedDue.length,
    newCount: selectedNew.length,
    queueWordIds,
    eligibleWordIds,
    laterTodayCount: laterToday.length,
    listIds: options.listIds,
    effectiveNewLimit,
    recoveryDays: dailyReviewLimit > 0
      ? (recoveryMode ? Math.max(3, Math.ceil(dueRows.length / dailyReviewLimit)) : Math.max(1, Math.ceil(dueRows.length / dailyReviewLimit)))
      : 0,
    daysSinceLastStudy,
    recoveryMode,
    backlogDueCount: dueRows.length,
    nextDueAt: laterToday[0]?.state.nextReviewAt,
    listContributions,
  }
}

function getTodayKey(date = new Date()): string {
  return dayjs(date).format('YYYY-MM-DD')
}

export function getCachedStudyPlan(): StudyPlan | null {
  if (!planCache) {
    return null
  }

  const isToday = planCache.dayKey === getTodayKey()
  if (isToday) {
    return planCache.plan
  }

  return null
}

export function invalidateStudyPlanCache(): void {
  if (planCache) planCache.stale = true
  studyRowsCache = null
}

export async function buildTodayPlanCached(): Promise<StudyPlan> {
  const [settings, revision] = await Promise.all([loadSettings(), getStudyDataRevision()])
  const dayKey = getTodayKey()

  if (
    planCache &&
    planCache.dayKey === dayKey &&
    planCache.revision === revision &&
    planCache.dailyNewLimit === settings.dailyNewLimit &&
    planCache.dailyReviewLimit === settings.dailyReviewLimit
    && (!planCache.nextDueAt || Date.parse(planCache.nextDueAt) > Date.now())
    && !planCache.stale
  ) {
    return planCache.plan
  }

  const plan = await buildTodayPlan({
    dailyNewLimit: settings.dailyNewLimit,
    dailyReviewLimit: settings.dailyReviewLimit,
  })

  planCache = {
    plan,
    revision,
    dailyNewLimit: settings.dailyNewLimit,
    dailyReviewLimit: settings.dailyReviewLimit,
    dayKey,
    nextDueAt: plan.nextDueAt,
    stale: false,
  }

  await db.syncMeta.put({ key: 'study-plan-cache-v1', value: planCache })

  return plan
}

export async function listEligibleStudyWordIds(
  excludeWordIds: string[] = [],
  listIds?: string[],
  at = new Date(),
): Promise<string[]> {
  const plan = await buildTodayPlan({
    at,
    listIds,
    excludeWordIds,
    dailyNewLimit: Number.MAX_SAFE_INTEGER,
    dailyReviewLimit: Number.MAX_SAFE_INTEGER,
    includeImportBacklog: false,
  })
  return plan.eligibleWordIds ?? plan.queueWordIds
}

export const STUDY_PLAN_REFRESHED_EVENT = 'wordsbook:study-plan-refreshed'

export interface StaleStudyPlanResult {
  plan: StudyPlan
  stale: boolean
  refreshPromise?: Promise<StudyPlan>
}

async function refreshAndNotifyStudyPlan(): Promise<StudyPlan> {
  const plan = await buildTodayPlanCached()
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(STUDY_PLAN_REFRESHED_EVENT, { detail: plan }))
  return plan
}

export async function getTodayPlanStaleWhileRevalidate(): Promise<StaleStudyPlanResult> {
  const dayKey = getTodayKey()
  if (!planCache) {
    const persisted = await db.syncMeta.get('study-plan-cache-v1')
    const value = persisted?.value as PlanCache | undefined
    if (value?.dayKey === dayKey) planCache = { ...value, stale: true }
  }
  if (!planCache || planCache.dayKey !== dayKey) {
    return { plan: await buildTodayPlanCached(), stale: false }
  }
  const stale = Boolean(planCache.stale)
  return {
    plan: planCache.plan,
    stale,
    refreshPromise: stale ? refreshAndNotifyStudyPlan() : undefined,
  }
}

export function scheduleTodayPlanPrewarm(): void {
  if (typeof window === 'undefined') return
  const run = () => { void refreshAndNotifyStudyPlan().catch(() => undefined) }
  if ('requestIdleCallback' in window) window.requestIdleCallback(run, { timeout: 1500 })
  else globalThis.setTimeout(run, 0)
}

export async function buildAdditionalStudyWordIds(
  count: number,
  excludeWordIds: string[] = [],
  listIds?: string[],
  at = new Date(),
): Promise<string[]> {
  const normalizedCount = Math.max(0, Math.floor(count))
  if (!normalizedCount) return []
  const excluded = new Set(excludeWordIds)
  const rows = (await getActiveStateRows(listIds, true)).filter((row) => !excluded.has(row.wordId) && !row.state.suspendedAt)
  const due = rows
    .filter((row) => (row.state.reps ?? row.state.totalReviews) > 0 && !dayjs(row.state.nextReviewAt).isAfter(at))
    .sort((left, right) => getReviewRetrievability(left.state, at) - getReviewRetrievability(right.state, at)
      || left.state.nextReviewAt.localeCompare(right.state.nextReviewAt))
  const fresh = rows
    .filter((row) => (row.state.reps ?? row.state.totalReviews) === 0)
    .sort((left, right) => Number(right.learningEnabled) - Number(left.learningEnabled)
      || right.sourcePriority - left.sourcePriority
      || right.joinedAt.localeCompare(left.joinedAt))
  let dueTarget = due.length && fresh.length ? Math.max(1, Math.ceil(normalizedCount * 0.6)) : normalizedCount
  let newTarget = due.length && fresh.length ? Math.max(1, normalizedCount - dueTarget) : 0
  if (!due.length) { dueTarget = 0; newTarget = normalizedCount }
  if (!fresh.length) { dueTarget = normalizedCount; newTarget = 0 }
  const pickedDue = due.slice(0, dueTarget)
  const pickedNew = fresh.slice(0, newTarget)
  const remaining = normalizedCount - pickedDue.length - pickedNew.length
  if (remaining > 0) {
    const dueRest = due.slice(pickedDue.length)
    const newRest = fresh.slice(pickedNew.length)
    for (const row of [...dueRest, ...newRest].slice(0, remaining)) {
      if ((row.state.reps ?? row.state.totalReviews) === 0) pickedNew.push(row)
      else pickedDue.push(row)
    }
  }
  const result: string[] = []
  while (pickedDue.length || pickedNew.length) {
    for (const row of [pickedDue.shift(), pickedNew.shift()]) if (row) result.push(row.wordId)
  }
  const selected = result.slice(0, normalizedCount)
  const selectedSet = new Set(selected)
  const promotedMembershipIds = [...new Set(rows.filter((row) => selectedSet.has(row.wordId) && !row.learningEnabled).flatMap((row) => row.membershipIds))]
  if (promotedMembershipIds.length) {
    const memberships = await db.studyListItems.bulkGet(promotedMembershipIds)
    const now = new Date().toISOString()
    const promoted = memberships.flatMap((membership) => membership ? [{ ...membership, learningEnabled: 1 as const, autoActivate: 0 as const }] : [])
    await db.studyListItems.bulkPut(promoted)
    for (const membership of promoted) await markPayloadChanged('studyListItems', membership, now)
    await markStudyDataChanged()
  }
  return avoidAdjacentWordInitials(selected, new Map(rows.map((row) => [row.wordId, row.headword])))
}

export async function loadReviewCards(wordIds: string[]): Promise<ReviewCard[]> {
  if (wordIds.length === 0) {
    return []
  }

  await repairVocabularyIntegrity(wordIds)
  const wordbookRows = await db.wordbook.bulkGet(wordIds)
  const filteredWordbookRows = wordbookRows.filter((row): row is NonNullable<typeof row> => row !== undefined)

  const [rawEntries, states] = await Promise.all([
    db.dictionaryEntries.bulkGet(filteredWordbookRows.map((row) => row.entryId)),
    db.reviewState.bulkGet(filteredWordbookRows.map((row) => row.wordId)),
  ])

  const entries = await applyAiOverrides(
    rawEntries.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined),
  )
  const entryMap = new Map(entries.map((entry) => [entry.entryId, entry]))

  return filteredWordbookRows
    .map((item, index) => {
      const entry = entryMap.get(item.entryId) ?? dictionaryEntryFromWordbook(item)
      const reviewState = states[index]
      if (!reviewState || !entry) {
        return undefined
      }

      return {
        wordId: item.wordId,
        entryId: item.entryId,
        note: item.note,
        tags: item.tags,
        entry,
        reviewState,
      }
    })
    .filter((card): card is ReviewCard => card !== undefined)
}

export async function gradeCard(
  wordId: string,
  rating: ReviewRating,
  reviewedAt = new Date(),
  session?: {
    attemptCount: number
    ratings: ReviewRating[]
    masteryBefore: number
    masteryAfter: number
  },
): Promise<ReviewState> {
  return db.transaction('rw', [db.reviewState, db.reviewLogs, db.syncMeta, db.syncRecords, db.syncTombstones], async () => {
    const prepared = await prepareCardGrade(wordId, rating, reviewedAt, session)
    await persistPreparedCardGrade(prepared)
    return prepared.updatedState
  })
}

export interface PreparedCardGrade {
  updatedState: ReviewState
  log: ReviewLog
}

/**
 * Builds an FSRS transition without opening a transaction. Queue commands use
 * this inside their own transaction so the canonical grade, activity evidence
 * and queue mutation either all commit or all roll back.
 */
export async function prepareCardGrade(
  wordId: string,
  rating: ReviewRating,
  reviewedAt = new Date(),
  session?: {
    attemptCount: number
    ratings: ReviewRating[]
    masteryBefore: number
    masteryAfter: number
  },
  source: ReviewLog['source'] = 'flashcard',
): Promise<PreparedCardGrade> {
  const state = await db.reviewState.get(wordId)
  if (!state) throw new Error('Review state missing')

  const normalizedState = isFsrsReviewState(state)
    ? state
    : migrateLegacyReviewState(
        state,
        await db.reviewLogs.where('wordId').equals(wordId).toArray(),
        state.nextReviewAt,
      )
  const result = scheduleFsrsReview(normalizedState, rating, reviewedAt)
  const updatedState: ReviewState = {
    ...cardToReviewState(wordId, result.card, normalizedState),
    cycle: normalizedState.cycle,
    successCount: normalizedState.successCount + (rating === 'good' || rating === 'easy' ? 1 : 0),
    lapseCount: result.card.lapses,
    totalReviews: result.card.reps,
    sameDayRelearnAt: undefined,
  }
  const log: ReviewLog = {
    wordId,
    reviewedAt: reviewedAt.toISOString(),
    rating,
    source,
    wasNew: (normalizedState.reps ?? normalizedState.totalReviews) === 0,
    cycleBefore: normalizedState.cycle,
    cycleAfter: updatedState.cycle,
    nextReviewAtBefore: normalizedState.nextReviewAt,
    nextReviewAtAfter: updatedState.nextReviewAt,
    stateBefore: normalizedState.fsrsState,
    stateAfter: updatedState.fsrsState,
    stabilityBefore: normalizedState.stability,
    stabilityAfter: updatedState.stability,
    difficultyBefore: normalizedState.difficulty,
    difficultyAfter: updatedState.difficulty,
    sessionAttemptCount: session?.attemptCount,
    sessionRatings: session?.ratings,
    todayMasteryBefore: session?.masteryBefore,
    todayMasteryAfter: session?.masteryAfter,
  }
  return { updatedState, log }
}

/** Persists a prepared transition in the caller's current Dexie transaction. */
export async function persistPreparedCardGrade(prepared: PreparedCardGrade): Promise<void> {
  await db.reviewState.put(prepared.updatedState)
  await db.reviewLogs.add(prepared.log)
  await markRecordChanged('reviewState', prepared.updatedState.wordId, prepared.log.reviewedAt)
  await markPayloadChanged('reviewLogs', prepared.log, prepared.log.reviewedAt)
}

export interface CardIntervalPreview {
  longTerm?: string
  sameDay: string
  appliesToLongTerm: boolean
}

export type CardIntervalPreviewMap = Record<ReviewRating, CardIntervalPreview>

export interface CardIntervalPreviewContext {
  canonicalGradeCommitted?: boolean
  attemptNo?: number
}

export async function previewCardIntervals(
  wordId: string,
  reviewedAt = new Date(),
  context: CardIntervalPreviewContext = {},
): Promise<CardIntervalPreviewMap> {
  const state = await db.reviewState.get(wordId)
  if (!state) throw new Error('Review state missing')
  const appliesToLongTerm = context.canonicalGradeCommitted !== true
  const preview = appliesToLongTerm ? previewFsrsReviews(state, reviewedAt) : undefined
  const repeatedFailure = (context.attemptNo ?? 1) >= 2
  const failedAgainText = repeatedFailure ? '今日约 15 分钟后微复习' : '今日至少 1 分钟后再测'
  const failedHardText = repeatedFailure ? '今日约 15 分钟后微复习' : '今日至少 3 分钟后再测'
  return {
    again: {
      longTerm: preview ? formatInterval(reviewedAt, preview.again.card.due) : undefined,
      sameDay: failedAgainText,
      appliesToLongTerm,
    },
    hard: {
      longTerm: preview ? formatInterval(reviewedAt, preview.hard.card.due) : undefined,
      sameDay: failedHardText,
      appliesToLongTerm,
    },
    good: {
      longTerm: preview ? formatInterval(reviewedAt, preview.good.card.due) : undefined,
      sameDay: '本轮通过',
      appliesToLongTerm,
    },
    easy: {
      longTerm: preview ? formatInterval(reviewedAt, preview.easy.card.due) : undefined,
      sameDay: '本轮通过',
      appliesToLongTerm,
    },
  }
}

export async function setWordSuspended(wordId: string, suspended: boolean): Promise<void> {
  const state = await db.reviewState.get(wordId)
  if (!state) throw new Error('Review state missing')
  await db.reviewState.put({ ...state, suspendedAt: suspended ? new Date().toISOString() : undefined })
  await markRecordChanged('reviewState', wordId)
  await markStudyDataChanged()
  invalidateStudyPlanCache()
}
