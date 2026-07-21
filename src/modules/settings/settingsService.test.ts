import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../../db/database'
import { loadSettings, saveSettings } from './settingsService'

describe('review settings', () => {
  beforeEach(async () => {
    db.close()
    await db.delete()
    await db.open()
  })

  it('migrates the old silent default to autoplay while preserving a later explicit choice', async () => {
    await db.settings.put({ key: 'autoPronunciation', value: false })
    expect((await loadSettings()).autoPronunciation).toBe(true)

    await saveSettings({ autoPronunciation: false })
    expect((await loadSettings()).autoPronunciation).toBe(false)
    expect((await db.settings.get('autoPronunciationConfigured'))?.value).toBe(true)
  })

  it('clamps oversized daily limits loaded from imports or cloud sync', async () => {
    await db.settings.bulkPut([
      { key: 'dailyNewLimit', value: 3861 },
      { key: 'dailyReviewLimit', value: 9999 },
    ])
    expect(await loadSettings()).toMatchObject({ dailyNewLimit: 200, dailyReviewLimit: 500 })
    expect(await saveSettings({ dailyNewLimit: -3, dailyReviewLimit: 900 })).toMatchObject({ dailyNewLimit: 0, dailyReviewLimit: 500 })
  })

  it('keeps round and article cadence settings within usable bounds', async () => {
    await db.settings.bulkPut([
      { key: 'roundWordCount', value: 0 },
      { key: 'articleEveryRounds', value: 99 },
    ])
    expect(await loadSettings()).toMatchObject({ roundWordCount: 1, articleEveryRounds: 12 })
    expect(await saveSettings({ roundWordCount: 7, articleEveryRounds: 3 })).toMatchObject({ roundWordCount: 7, articleEveryRounds: 3 })
  })
})
