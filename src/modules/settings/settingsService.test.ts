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
})
