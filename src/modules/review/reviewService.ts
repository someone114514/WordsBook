import dayjs from 'dayjs'
import { db } from '../../db/database'
import type { ReviewCard, ReviewRating, ReviewState, StudyPlan, WordbookItem } from '../../types/models'
import { dictionaryEntryFromWordbook, repairVocabularyIntegrity } from '../wordbook/vocabularyIntegrity'
import { applyAiOverrides } from '../dictionary/entryOverrideMapper'
import { loadSettings } from '../settings/settingsService'
import { markPayloadChanged, markRecordChanged } from '../sync/localSyncStore'
import { getStudyDataRevision, markStudyDataChanged } from './studyDataRevision'
import {
  cardToReviewState,
  formatInterval,
  migrateLegacyReviewState,
  previewFsrsReviews,
  scheduleFsrsReview,
  getReviewRetrievability,
} from './scheduler'

interface BuildPlanOptions {
  at?: Date
  dailyNewLimit?: number
  dailyReviewLimit?: number
  listIds?: string[]
  excludeWordIds?: string[]
  includeImportBacklog?: boolean
  promoteImportBacklog?: boolean
}

interface PlanCache {
  plan: StudyPlan
  revision: string
  dailyNewLimit: number
  dailyReviewLimit: number
  dayKey: string
}

let planCache: PlanCache | null = null

type ActiveStateRow = {
  wordId: string
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

function normalizedInitial(value: string | undefined): string {
  return (value ?? '').replace(/^[^a-z]+/i, '').charAt(0).toLowerCase()
}

export async function avoidAdjacentWordInitials(wordIds: string[]): Promise<string[]> {
  if (wordIds.length < 2) return [...wordIds]
  const words = await db.wordbook.bulkGet(wordIds)
  const initials = new Map(words.flatMap((word) => word
    ? [[word.wordId, normalizedInitial(word.headwordLower ?? word.headword)] as const]
    : []))
  const remaining = [...wordIds]
  const arranged: string[] = []
  while (remaining.length) {
    const previousInitial = initials.get(arranged[arranged.length - 1] ?? '')
    let candidateIndex = 0
    if (previousInitial) {
      const alternative = remaining.slice(0, 6).findIndex((wordId) => {
        const initial = initials.get(wordId)
        return Boolean(initial && initial !== previousInitial)
      })
      if (alternative >= 0) candidateIndex = alternative
    }
    arranged.push(remaining.splice(candidateIndex, 1)[0]!)
  }
  return arranged
}

async function getStudyWordbookRows(listIds?: string[], includeImportBacklog = false): Promise<Array<{ word: WordbookItem; listIds: string[]; sourcePriority: number; joinedAt: string; learningEnabled: boolean; membershipIds: string[] }>> {
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
  return words
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
      activeRows.push({ wordId: wordbookRow.word.wordId, state: existingState, listIds: wordbookRow.listIds, sourcePriority: wordbookRow.sourcePriority, joinedAt: wordbookRow.joinedAt, learningEnabled: wordbookRow.learningEnabled, membershipIds: wordbookRow.membershipIds })
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
    activeRows.push({ wordId: wordbookRow.word.wordId, state: fallbackState, listIds: wordbookRow.listIds, sourcePriority: wordbookRow.sourcePriority, joinedAt: wordbookRow.joinedAt, learningEnabled: wordbookRow.learningEnabled, membershipIds: wordbookRow.membershipIds })
  }

  if (missingStates.length > 0) {
    await db.reviewState.bulkPut(missingStates)
  }

  const legacyRows = activeRows.filter((row) => row.state.schedulerVersion !== 'fsrs-5')
  if (legacyRows.length > 0) {
    const legacyIds = new Set(legacyRows.map((row) => row.wordId))
    const logs = (await db.reviewLogs.toArray()).filter((log) => legacyIds.has(log.wordId))
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
  await repairVocabularyIntegrity()
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

  const dueRows = rows
    .filter((row) => {
      if (row.state.suspendedAt) return false
      return (row.state.reps ?? row.state.totalReviews) > 0 && !dayjs(row.state.nextReviewAt).isAfter(nowIso)
    })
    .sort((left, right) => {
      const retrievabilityDiff = getReviewRetrievability(left.state, now) - getReviewRetrievability(right.state, now)
      if (Math.abs(retrievabilityDiff) > 1e-6) return retrievabilityDiff
      return left.state.nextReviewAt.localeCompare(right.state.nextReviewAt)
    })

  const newRows = rows
    .filter((row) => !row.state.suspendedAt && (row.state.reps ?? row.state.totalReviews) === 0)
    .sort((left, right) => Number(right.learningEnabled) - Number(left.learningEnabled)
      || right.sourcePriority - left.sourcePriority
      || right.joinedAt.localeCompare(left.joinedAt)
      || left.state.nextReviewAt.localeCompare(right.state.nextReviewAt))

  const selectedDue = dueRows.slice(0, dailyReviewLimit)
  const effectiveNewLimit = dueRows.length > dailyReviewLimit
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
  const previousSession = await db.dailyLearningSessions.orderBy('dayKey').last()
  const daysSinceLastStudy = previousSession ? Math.max(0, dayjs(now).startOf('day').diff(previousSession.dayKey, 'day')) : 0

  const queueWordIds = await avoidAdjacentWordInitials(selectedRows.map((row) => row.wordId))
  return {
    // These counts describe the actual queue, not the entire backlog. This keeps
    // the headline total equal to "复习 + 新词" and makes the configured limits visible.
    dueCount: selectedDue.length,
    newCount: selectedNew.length,
    queueWordIds,
    laterTodayCount: 0,
    listIds: options.listIds,
    effectiveNewLimit,
    recoveryDays: dailyReviewLimit > 0 ? Math.max(1, Math.ceil(dueRows.length / dailyReviewLimit)) : 0,
    daysSinceLastStudy,
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
  planCache = null
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
  }

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
  return plan.queueWordIds
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
  return avoidAdjacentWordInitials(selected)
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
  const reviewedAtIso = reviewedAt.toISOString()

  return db.transaction('rw', [db.reviewState, db.reviewLogs, db.syncMeta, db.syncRecords, db.syncTombstones], async () => {
    const state = await db.reviewState.get(wordId)
    if (!state) {
      throw new Error('Review state missing')
    }

    const normalizedState = state.schedulerVersion === 'fsrs-5'
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
      successCount: normalizedState.successCount + (rating === 'good' ? 1 : 0),
      lapseCount: result.card.lapses,
      totalReviews: result.card.reps,
      sameDayRelearnAt: undefined,
    }

    await db.reviewState.put(updatedState)
    const log = {
      wordId,
      reviewedAt: reviewedAtIso,
      rating,
      source: 'flashcard' as const,
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
    await db.reviewLogs.add(log)
    await markRecordChanged('reviewState', wordId, reviewedAtIso)
    await markPayloadChanged('reviewLogs', log, reviewedAtIso)
    return updatedState
  })
}

export async function previewCardIntervals(
  wordId: string,
  reviewedAt = new Date(),
): Promise<Record<ReviewRating, string>> {
  const state = await db.reviewState.get(wordId)
  if (!state) throw new Error('Review state missing')
  const preview = previewFsrsReviews(state, reviewedAt)
  return {
    again: formatInterval(reviewedAt, preview.again.card.due),
    hard: formatInterval(reviewedAt, preview.hard.card.due),
    good: formatInterval(reviewedAt, preview.good.card.due),
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
