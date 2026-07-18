import { db } from '../../db/database'

const REVISION_KEY = 'study-data-revision'
const QUEUE_REVISION_KEY = 'study-queue-source-revision'
export const STUDY_DATA_CHANGED_EVENT = 'wordsbook:study-data-changed'

function createRevision(at = new Date()): string {
  return `${at.toISOString()}:${crypto.randomUUID()}`
}

export async function getStudyDataRevision(): Promise<string> {
  const row = await db.syncMeta.get(REVISION_KEY)
  return typeof row?.value === 'string' ? row.value : '0'
}

export async function getStudyQueueRevision(): Promise<string> {
  const row = await db.syncMeta.get(QUEUE_REVISION_KEY)
  return typeof row?.value === 'string' ? row.value : '0'
}

export async function markStudyDataChanged(options: { affectsQueue?: boolean; at?: Date } = {}): Promise<string> {
  const at = options.at ?? new Date()
  const revision = createRevision(at)
  await db.syncMeta.put({ key: REVISION_KEY, value: revision })
  if (options.affectsQueue !== false) await db.syncMeta.put({ key: QUEUE_REVISION_KEY, value: revision })
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(STUDY_DATA_CHANGED_EVENT, { detail: revision }))
  }
  return revision
}
