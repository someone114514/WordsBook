import 'fake-indexeddb/auto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../../db/database'
import { importUserData } from '../settings/backupService'
import { buildTodayPlan } from './reviewService'

describe('review data migration', () => {
  beforeEach(async () => {
    db.close()
    await db.delete()
    await db.open()
  })

  it('replays the 536-word legacy backup into FSRS without importing the API key', async () => {
    const bytes = readFileSync(resolve('backup/wordsbook-backup-2026-06-08.json'))
    await importUserData(new Blob([bytes], { type: 'application/json' }))
    await buildTodayPlan({ at: new Date('2026-07-13T08:00:00.000Z'), dailyNewLimit: 20, dailyReviewLimit: 200 })
    const states = await db.reviewState.toArray()
    expect(states).toHaveLength(536)
    expect(states.every((state) => state.schedulerVersion === 'fsrs-5')).toBe(true)
    expect(await db.reviewLogs.count()).toBe(3372)
    expect(await db.settings.get('deepseekApiKey')).toBeUndefined()
    expect((await db.localSecrets.get('deepseekApiKey'))?.value).toBeUndefined()
  })
})
