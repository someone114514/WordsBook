import { db } from '../../db/database'
import type { AppSettings } from '../../types/models'
import { markRecordChanged, markRecordDeleted } from '../sync/localSyncStore'
import { markStudyDataChanged } from '../review/studyDataRevision'

export const DEFAULT_SETTINGS: AppSettings = {
  autoPronunciation: true,
  speechRate: 1,
  ttsEngine: 'auto',
  dailyNewLimit: 20,
  dailyReviewLimit: 200,
  roundWordCount: 5,
  articleEveryRounds: 2,
  deepseekApiKey: '',
  deepseekBaseUrl: 'https://api.deepseek.com/v1/chat/completions',
  deepseekModel: 'deepseek-v4-flash',
  articleLevel: 'B2',
  syncDeepseekApiKey: false,
}

export const DAILY_NEW_LIMIT_MAX = 200
export const DAILY_REVIEW_LIMIT_MAX = 500
export const ROUND_WORD_COUNT_MAX = 12
export const ARTICLE_EVERY_ROUNDS_MAX = 12

function clampInteger(value: number, maximum: number): number {
  return Math.min(maximum, Math.max(0, Math.floor(value)))
}

export async function loadSettings(): Promise<AppSettings> {
  const rows = await db.settings.toArray()
  const output: AppSettings = { ...DEFAULT_SETTINGS }
  const storedSecret = await db.localSecrets.get('deepseekApiKey')
  const autoPronunciationConfigured = rows.some(
    (row) => row.key === 'autoPronunciationConfigured' && row.value === true,
  )
  output.deepseekApiKey = storedSecret?.value ?? ''

  for (const row of rows) {
    if (row.key === 'autoPronunciation' && typeof row.value === 'boolean') {
      // Older versions persisted the old false default whenever any setting was
      // saved. Treat it as the new true default until the user explicitly toggles it.
      output.autoPronunciation = autoPronunciationConfigured ? row.value : true
    }

    if (row.key === 'speechRate' && typeof row.value === 'number') {
      output.speechRate = row.value
    }

    if (
      row.key === 'ttsEngine' &&
      typeof row.value === 'string' &&
      ['auto', 'browser', 'youdao', 'google', 'dictionaryapi'].includes(row.value)
    ) {
      output.ttsEngine = row.value as AppSettings['ttsEngine']
    }

    if (row.key === 'dailyNewLimit' && typeof row.value === 'number') {
      output.dailyNewLimit = row.value
    }

    if (row.key === 'dailyReviewLimit' && typeof row.value === 'number') {
      output.dailyReviewLimit = row.value
    }

    if (row.key === 'roundWordCount' && typeof row.value === 'number') {
      output.roundWordCount = row.value
    }

    if (row.key === 'articleEveryRounds' && typeof row.value === 'number') {
      output.articleEveryRounds = row.value
    }

    if (
      row.key === 'deepseekApiKey' &&
      typeof row.value === 'string' &&
      row.value &&
      !storedSecret
    ) {
      output.deepseekApiKey = row.value
      await db.localSecrets.put({ key: 'deepseekApiKey', value: row.value })
      await db.settings.delete('deepseekApiKey')
      await markRecordDeleted('settings', 'deepseekApiKey')
    }

    if (row.key === 'deepseekBaseUrl' && typeof row.value === 'string') {
      output.deepseekBaseUrl = row.value
    }

    if (row.key === 'deepseekModel' && typeof row.value === 'string') {
      output.deepseekModel = row.value
    }

    if (
      row.key === 'articleLevel' &&
      typeof row.value === 'string' &&
      ['A2', 'B1', 'B2', 'C1'].includes(row.value)
    ) {
      output.articleLevel = row.value as AppSettings['articleLevel']
    }

    if (row.key === 'syncDeepseekApiKey' && typeof row.value === 'boolean') {
      output.syncDeepseekApiKey = row.value
    }
  }

  // Treat imported/cloud settings as untrusted input too. HTML min/max only
  // constrain the current form and cannot repair older oversized values.
  output.dailyNewLimit = clampInteger(output.dailyNewLimit, DAILY_NEW_LIMIT_MAX)
  output.dailyReviewLimit = clampInteger(output.dailyReviewLimit, DAILY_REVIEW_LIMIT_MAX)
  output.roundWordCount = Math.max(1, clampInteger(output.roundWordCount, ROUND_WORD_COUNT_MAX))
  output.articleEveryRounds = Math.max(1, clampInteger(output.articleEveryRounds, ARTICLE_EVERY_ROUNDS_MAX))
  return output
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const previousSettings = await loadSettings()
  const sanitizedPatch: Partial<AppSettings> = {
    ...patch,
    ...(patch.dailyNewLimit === undefined ? {} : { dailyNewLimit: clampInteger(patch.dailyNewLimit, DAILY_NEW_LIMIT_MAX) }),
    ...(patch.dailyReviewLimit === undefined ? {} : { dailyReviewLimit: clampInteger(patch.dailyReviewLimit, DAILY_REVIEW_LIMIT_MAX) }),
    ...(patch.roundWordCount === undefined ? {} : { roundWordCount: Math.max(1, clampInteger(patch.roundWordCount, ROUND_WORD_COUNT_MAX)) }),
    ...(patch.articleEveryRounds === undefined ? {} : { articleEveryRounds: Math.max(1, clampInteger(patch.articleEveryRounds, ARTICLE_EVERY_ROUNDS_MAX)) }),
  }
  const nextSettings = { ...previousSettings, ...sanitizedPatch }

  if (sanitizedPatch.deepseekApiKey !== undefined) {
    await db.localSecrets.put({ key: 'deepseekApiKey', value: sanitizedPatch.deepseekApiKey, updatedAt: new Date().toISOString() })
  }

  await db.transaction('rw', [db.settings, db.syncMeta, db.syncRecords, db.syncTombstones], async () => {
    await Promise.all(
      Object.entries(nextSettings)
        .filter(([key]) => key !== 'deepseekApiKey')
        .map(async ([key, value]) => {
        await db.settings.put({ key, value })
        await markRecordChanged('settings', key)
      }),
    )
    if (sanitizedPatch.autoPronunciation !== undefined) {
      await db.settings.put({ key: 'autoPronunciationConfigured', value: true })
      await markRecordChanged('settings', 'autoPronunciationConfigured')
    }
    await db.settings.delete('deepseekApiKey')
  })

  if ((sanitizedPatch.dailyNewLimit !== undefined && sanitizedPatch.dailyNewLimit !== previousSettings.dailyNewLimit)
    || (sanitizedPatch.dailyReviewLimit !== undefined && sanitizedPatch.dailyReviewLimit !== previousSettings.dailyReviewLimit)
    || (sanitizedPatch.roundWordCount !== undefined && sanitizedPatch.roundWordCount !== previousSettings.roundWordCount)
    || (sanitizedPatch.articleEveryRounds !== undefined && sanitizedPatch.articleEveryRounds !== previousSettings.articleEveryRounds)) {
    await markStudyDataChanged({ affectsQueue: false })
  }

  return nextSettings
}
