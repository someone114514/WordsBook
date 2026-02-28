import { db } from '../../db/database'
import type { BackupPayload, ImportReport } from '../../types/models'

const BACKUP_SCHEMA_VERSION = 1

function isBackupPayload(raw: unknown): raw is BackupPayload {
  if (typeof raw !== 'object' || raw === null) {
    return false
  }

  const candidate = raw as Record<string, unknown>
  return (
    typeof candidate.schemaVersion === 'number' &&
    Array.isArray(candidate.wordbook) &&
    Array.isArray(candidate.reviewState) &&
    Array.isArray(candidate.reviewLogs) &&
    Array.isArray(candidate.settings)
  )
}

export async function exportUserData(): Promise<Blob> {
  const payload: BackupPayload = {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    wordbook: await db.wordbook.toArray(),
    reviewState: await db.reviewState.toArray(),
    reviewLogs: await db.reviewLogs.toArray(),
    settings: await db.settings.toArray(),
  }

  const serialized = JSON.stringify(payload, null, 2)
  return new Blob([serialized], { type: 'application/json' })
}

async function blobToText(input: Blob): Promise<string> {
  return input.text()
}

export async function importUserData(input: Blob): Promise<ImportReport> {
  const text = await blobToText(input)
  const parsed: unknown = JSON.parse(text)

  if (!isBackupPayload(parsed)) {
    throw new Error('Invalid backup file format')
  }

  const payload = parsed as BackupPayload

  await db.transaction('rw', db.wordbook, db.reviewState, db.reviewLogs, db.settings, async () => {
    await db.wordbook.bulkPut(payload.wordbook)
    await db.reviewState.bulkPut(payload.reviewState)
    await db.reviewLogs.bulkPut(payload.reviewLogs)
    await db.settings.bulkPut(payload.settings)
  })

  return {
    importedWordbook: payload.wordbook.length,
    importedReviewState: payload.reviewState.length,
    importedReviewLogs: payload.reviewLogs.length,
    importedSettings: payload.settings.length,
  }
}
