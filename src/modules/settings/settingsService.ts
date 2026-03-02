import { db } from '../../db/database'
import type { AppSettings } from '../../types/models'

export const DEFAULT_SETTINGS: AppSettings = {
  autoPronunciation: false,
  speechRate: 1,
  dailyNewLimit: 20,
  dailyReviewLimit: 200,
  deepseekApiKey: '',
  deepseekBaseUrl: 'https://api.deepseek.com/v1/chat/completions',
  deepseekModel: 'deepseek-chat',
}

export async function loadSettings(): Promise<AppSettings> {
  const rows = await db.settings.toArray()
  const output: AppSettings = { ...DEFAULT_SETTINGS }

  for (const row of rows) {
    if (row.key === 'autoPronunciation' && typeof row.value === 'boolean') {
      output.autoPronunciation = row.value
    }

    if (row.key === 'speechRate' && typeof row.value === 'number') {
      output.speechRate = row.value
    }

    if (row.key === 'dailyNewLimit' && typeof row.value === 'number') {
      output.dailyNewLimit = row.value
    }

    if (row.key === 'dailyReviewLimit' && typeof row.value === 'number') {
      output.dailyReviewLimit = row.value
    }

    if (row.key === 'deepseekApiKey' && typeof row.value === 'string') {
      output.deepseekApiKey = row.value
    }

    if (row.key === 'deepseekBaseUrl' && typeof row.value === 'string') {
      output.deepseekBaseUrl = row.value
    }

    if (row.key === 'deepseekModel' && typeof row.value === 'string') {
      output.deepseekModel = row.value
    }
  }

  return output
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const nextSettings = { ...(await loadSettings()), ...patch }

  await db.transaction('rw', db.settings, async () => {
    await Promise.all(
      Object.entries(nextSettings).map(([key, value]) => db.settings.put({ key, value })),
    )
  })

  return nextSettings
}
