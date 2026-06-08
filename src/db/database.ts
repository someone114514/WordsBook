import Dexie, { type Table } from 'dexie'
import type {
  AiOverrideHistoryRecord,
  AiOverrideRecord,
  DictionaryEntry,
  DictionaryIndexRow,
  DictionaryMeta,
  ReviewLog,
  ReviewState,
  SyncMetaRecord,
  SyncRecordMeta,
  SyncTombstone,
  SettingItem,
  WordbookItem,
} from '../types/models'

class WordsBookDB extends Dexie {
  dictionaryMeta!: Table<DictionaryMeta, string>
  dictionaryEntries!: Table<DictionaryEntry, string>
  dictionaryIndex!: Table<DictionaryIndexRow, string>
  wordbook!: Table<WordbookItem, string>
  reviewState!: Table<ReviewState, string>
  reviewLogs!: Table<ReviewLog, number>
  settings!: Table<SettingItem, string>
  aiOverrides!: Table<AiOverrideRecord, string>
  aiOverrideHistory!: Table<AiOverrideHistoryRecord, number>
  syncMeta!: Table<SyncMetaRecord, string>
  syncRecords!: Table<SyncRecordMeta, string>
  syncTombstones!: Table<SyncTombstone, string>

  public constructor() {
    super('wordsbook-db')

    this.version(1).stores({
      dictionaryMeta: '&id, version, installedAt',
      dictionaryEntries: '&entryId, headwordLower',
      dictionaryIndex: '&token',
      wordbook: '&wordId, &entryId, addedAt, archived',
      reviewState: '&wordId, nextReviewAt, cycle, totalReviews',
      reviewLogs: '++id, wordId, reviewedAt, [wordId+reviewedAt]',
      settings: '&key',
    })

    this.version(2).stores({
      dictionaryMeta: '&id, version, installedAt',
      dictionaryEntries: '&entryId, headwordLower',
      dictionaryIndex: '&token',
      wordbook: '&wordId, &entryId, addedAt, archived',
      reviewState: '&wordId, nextReviewAt, cycle, totalReviews',
      reviewLogs: '++id, wordId, reviewedAt, [wordId+reviewedAt]',
      settings: '&key',
      aiOverrides: '&entryId, mode, createdAt',
      aiOverrideHistory: '++id, entryId, createdAt',
    })

    this.version(3).stores({
      dictionaryMeta: '&id, version, installedAt',
      dictionaryEntries: '&entryId, headwordLower',
      dictionaryIndex: '&token',
      wordbook: '&wordId, &entryId, addedAt, archived',
      reviewState: '&wordId, nextReviewAt, cycle, totalReviews',
      reviewLogs: '++id, wordId, reviewedAt, [wordId+reviewedAt]',
      settings: '&key',
      aiOverrides: '&entryId, mode, createdAt',
      aiOverrideHistory: '++id, entryId, createdAt',
      syncMeta: '&key',
      syncRecords: '&key, entity, recordId, updatedAt, deletedAt',
      syncTombstones: '&key, entity, recordId, deletedAt',
    })
  }
}

export const db = new WordsBookDB()
