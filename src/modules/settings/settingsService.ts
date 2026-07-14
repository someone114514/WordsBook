import { db } from '../../db/database'
import type { AppSettings } from '../../types/models'
import { markRecordChanged, markRecordDeleted } from '../sync/localSyncStore'

export const DEFAULT_SETTINGS: AppSettings = {
  autoPronunciation: true,
  speechRate: 1,
  ttsEngine: 'auto',
  dailyNewLimit: 20,
  dailyReviewLimit: 200,
  deepseekApiKey: '',
  deepseekBaseUrl: 'https://api.deepseek.com/v1/chat/completions',
  deepseekModel: 'deepseek-chat',
  articleLevel: 'B2',
  syncDeepseekApiKey: false,
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

  return output
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const nextSettings = { ...(await loadSettings()), ...patch }

  if (patch.deepseekApiKey !== undefined) {
    await db.localSecrets.put({ key: 'deepseekApiKey', value: patch.deepseekApiKey, updatedAt: new Date().toISOString() })
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
    if (patch.autoPronunciation !== undefined) {
      await db.settings.put({ key: 'autoPronunciationConfigured', value: true })
      await markRecordChanged('settings', 'autoPronunciationConfigured')
    }
    await db.settings.delete('deepseekApiKey')
  })

  return nextSettings
}
