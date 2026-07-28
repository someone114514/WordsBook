import {
  Rating,
  State,
  createEmptyCard,
  default_w,
  fsrs,
  type Card,
  type Grade,
  type RecordLogItem,
} from 'ts-fsrs'
import type { ReviewLog, ReviewRating, ReviewState, SchedulerRating } from '../../types/models'

export const REVIEW_INTERVAL_DAYS = [0, 1, 2, 4, 7, 15, 30, 60] as const
export const DEFAULT_FSRS_PARAMETERS = [...default_w]

function createReviewScheduler(parameters = DEFAULT_FSRS_PARAMETERS) {
  return fsrs({
    w: parameters,
    request_retention: 0.9,
    maximum_interval: 36500,
    enable_fuzz: true,
    enable_short_term: false,
    learning_steps: [],
    relearning_steps: [],
  })
}

export let reviewScheduler = createReviewScheduler()

export function configureReviewScheduler(parameters?: readonly number[]): boolean {
  const next = parameters ?? DEFAULT_FSRS_PARAMETERS
  if (next.length !== DEFAULT_FSRS_PARAMETERS.length || next.some((value) => !Number.isFinite(value))) return false
  reviewScheduler = createReviewScheduler([...next])
  return true
}

export const RATING_TO_FSRS: Record<SchedulerRating, Grade> = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
}

export function normalizeReviewRating(rating: ReviewLog['rating']): SchedulerRating {
  if (rating === 'forget') return 'again'
  if (rating === 'remember') return 'good'
  return rating
}

export function reviewStateToCard(state: ReviewState): Card {
  if (state.schedulerVersion !== 'fsrs-5') {
    return createEmptyCard(state.nextReviewAt)
  }

  return {
    due: new Date(state.nextReviewAt),
    stability: state.stability ?? 0,
    difficulty: state.difficulty ?? 0,
    elapsed_days: state.elapsedDays ?? 0,
    scheduled_days: state.scheduledDays ?? 0,
    learning_steps: state.learningSteps ?? 0,
    reps: state.reps ?? state.totalReviews,
    lapses: state.lapses ?? state.lapseCount,
    state: (state.fsrsState ?? State.New) as State,
    last_review: state.lastReviewedAt ? new Date(state.lastReviewedAt) : undefined,
  }
}

export function cardToReviewState(
  wordId: string,
  card: Card,
  previous?: ReviewState,
): ReviewState {
  return {
    wordId,
    cycle: previous?.cycle ?? 0,
    lastReviewedAt: card.last_review?.toISOString(),
    nextReviewAt: card.due.toISOString(),
    successCount: previous?.successCount ?? 0,
    lapseCount: card.lapses,
    totalReviews: card.reps,
    fsrsState: card.state,
    stability: card.stability,
    difficulty: card.difficulty,
    elapsedDays: card.elapsed_days,
    scheduledDays: card.scheduled_days,
    learningSteps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    suspendedAt: previous?.suspendedAt,
    sameDayRelearnAt: previous?.sameDayRelearnAt,
    skillEvidenceJson: previous?.skillEvidenceJson,
    schedulerVersion: 'fsrs-5',
  }
}

export function previewFsrsReviews(state: ReviewState, reviewedAt = new Date()): Record<ReviewRating, RecordLogItem> {
  const preview = reviewScheduler.repeat(reviewStateToCard(state), reviewedAt)
  return {
    again: preview[Rating.Again],
    hard: preview[Rating.Hard],
    good: preview[Rating.Good],
    easy: preview[Rating.Easy],
  }
}

export function scheduleFsrsReview(
  state: ReviewState,
  rating: ReviewRating,
  reviewedAt = new Date(),
): RecordLogItem {
  return reviewScheduler.next(reviewStateToCard(state), reviewedAt, RATING_TO_FSRS[rating])
}

export function migrateLegacyReviewState(
  state: ReviewState,
  logs: ReviewLog[],
  createdAt: string,
): ReviewState {
  if (state.schedulerVersion === 'fsrs-5') return state
  return replayReviewState(state, logs, createdAt)
}

export function replayReviewState(
  state: ReviewState,
  logs: ReviewLog[],
  createdAt: string,
): ReviewState {
  let card = createEmptyCard(createdAt)
  const ordered = [...logs].sort((a, b) => a.reviewedAt.localeCompare(b.reviewedAt))
  for (const log of ordered) {
    card = reviewScheduler.next(
      card,
      new Date(log.reviewedAt),
      RATING_TO_FSRS[normalizeReviewRating(log.rating)],
    ).card
  }
  return cardToReviewState(state.wordId, card, state)
}

export function formatInterval(from: Date, due: Date): string {
  const days = Math.max(1, Math.round((due.getTime() - from.getTime()) / 86400000))
  if (days === 1) return '明天'
  if (days < 365) return `${days}天`
  return `${Math.round(days / 365)}年`
}

export function getReviewRetrievability(state: ReviewState, at = new Date()): number {
  if ((state.reps ?? state.totalReviews) === 0 || state.schedulerVersion !== 'fsrs-5') return 0
  try {
    const value = reviewScheduler.get_retrievability(reviewStateToCard(state), at, false)
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
  } catch {
    // A partially imported FSRS card must not make the learning queue unusable.
    return 0
  }
}

// Backwards-compatible helpers retained for old imports and backup tests.
export function clampCycle(cycle: number): number {
  return Math.max(0, Math.min(REVIEW_INTERVAL_DAYS.length - 1, cycle))
}

export function computeNextReviewAt(reviewedAt: string, cycle: number): string {
  const date = new Date(reviewedAt)
  date.setUTCDate(date.getUTCDate() + REVIEW_INTERVAL_DAYS[clampCycle(cycle)]!)
  return date.toISOString()
}

export function computeNextReviewState(
  state: ReviewState,
  rating: 'remember' | 'forget',
  reviewedAt: string,
) {
  const cycleBefore = clampCycle(state.cycle)
  const cycleAfter = rating === 'remember' ? clampCycle(cycleBefore + 1) : clampCycle(cycleBefore - 1)
  return {
    cycleBefore,
    cycleAfter,
    nextReviewAtBefore: state.nextReviewAt,
    nextReviewAtAfter: computeNextReviewAt(reviewedAt, cycleAfter),
  }
}
