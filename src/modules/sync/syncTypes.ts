import type {
  AiOverrideHistoryRecord,
  AiOverrideRecord,
  DictionaryEntry,
  ReviewLog,
  ReviewState,
  SettingItem,
  SyncEntity,
  WordbookItem,
} from '../../types/models'

export type SyncPayloadByEntity = {
  dictionaryEntries: DictionaryEntry
  wordbook: WordbookItem
  reviewState: ReviewState
  reviewLogs: ReviewLog
  settings: SettingItem
  aiOverrides: AiOverrideRecord
  aiOverrideHistory: AiOverrideHistoryRecord
}

export type SyncPayload = SyncPayloadByEntity[SyncEntity]

export interface SyncRecord<E extends SyncEntity = SyncEntity> {
  entity: E
  recordId: string
  payload: SyncPayloadByEntity[E]
  updatedAt: string
  sourceClientId: string
}

export interface SyncDeletedRecord {
  entity: SyncEntity
  recordId: string
  deletedAt: string
  sourceClientId: string
}

export interface SyncDataset {
  records: SyncRecord[]
  tombstones: SyncDeletedRecord[]
}

export interface SyncPreview {
  upload: number
  download: number
  conflicts: number
  deletions: number
  blockedSettings: string[]
}

export interface SyncResult extends SyncPreview {
  pushed: number
  pulled: number
  deleted: number
  completedAt: string
}

export interface CloudSyncRemote {
  fetchAll(): Promise<SyncDataset>
  upsert(records: SyncRecord[]): Promise<void>
  delete(records: SyncDeletedRecord[]): Promise<void>
}

export type CloudSyncMode = 'upload' | 'download' | 'bidirectional'
