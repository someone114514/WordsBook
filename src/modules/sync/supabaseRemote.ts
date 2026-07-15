import type { SupabaseClient } from '@supabase/supabase-js'
import type { SyncEntity } from '../../types/models'
import type { CloudSyncRemote, SyncDataset, SyncDeletedRecord, SyncPayload, SyncRecord } from './syncTypes'

const SYNC_TABLE = 'wordsbook_sync_records'
const BATCH_SIZE = 300
const FETCH_BATCH_SIZE = 1000

interface SyncTableRow {
  user_id: string
  entity: SyncEntity
  record_id: string
  payload: SyncPayload | null
  updated_at: string
  deleted_at: string | null
  source_client_id: string
}

async function getCurrentUserId(client: SupabaseClient): Promise<string> {
  const { data, error } = await client.auth.getUser()
  if (error) {
    throw new Error(`云同步登录已失效，请重新登录后再同步（${error.message}）`)
  }

  const userId = data.user?.id
  if (!userId) {
    throw new Error('请先登录云同步账号')
  }

  return userId
}

async function runInBatches<T>(rows: T[], task: (chunk: T[]) => Promise<void>): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    await task(rows.slice(offset, offset + BATCH_SIZE))
  }
}

export class SupabaseCloudSyncRemote implements CloudSyncRemote {
  private readonly client: SupabaseClient

  public constructor(client: SupabaseClient) {
    this.client = client
  }

  async fetchAll(): Promise<SyncDataset> {
    const userId = await getCurrentUserId(this.client)

    const rows: SyncTableRow[] = []
    for (let offset = 0; ; offset += FETCH_BATCH_SIZE) {
      const { data, error } = await this.client
        .from(SYNC_TABLE)
        .select('entity, record_id, payload, updated_at, deleted_at, source_client_id')
        .eq('user_id', userId)
        .order('entity', { ascending: true })
        .order('record_id', { ascending: true })
        .range(offset, offset + FETCH_BATCH_SIZE - 1)

      if (error) {
        throw error
      }

      const chunk = (data ?? []) as SyncTableRow[]
      rows.push(...chunk)
      if (chunk.length < FETCH_BATCH_SIZE) {
        break
      }
    }

    const records: SyncRecord[] = []
    const tombstones: SyncDeletedRecord[] = []
    for (const row of rows) {
      if (row.deleted_at) {
        tombstones.push({
          entity: row.entity,
          recordId: row.record_id,
          deletedAt: row.deleted_at,
          sourceClientId: row.source_client_id,
        })
        continue
      }

      if (!row.payload) {
        continue
      }

      records.push({
        entity: row.entity,
        recordId: row.record_id,
        payload: row.payload,
        updatedAt: row.updated_at,
        sourceClientId: row.source_client_id,
      } as SyncRecord)
    }

    return { records, tombstones }
  }

  async upsert(records: SyncRecord[]): Promise<void> {
    if (records.length === 0) {
      return
    }

    const userId = await getCurrentUserId(this.client)
    await runInBatches(records, async (chunk) => {
      const rows: SyncTableRow[] = chunk.map((record) => ({
        user_id: userId,
        entity: record.entity,
        record_id: record.recordId,
        payload: record.payload,
        updated_at: record.updatedAt,
        deleted_at: null,
        source_client_id: record.sourceClientId,
      }))
      const { error } = await this.client.from(SYNC_TABLE).upsert(rows, {
        onConflict: 'user_id,entity,record_id',
      })
      if (error) {
        throw error
      }
    })
  }

  async delete(records: SyncDeletedRecord[]): Promise<void> {
    if (records.length === 0) {
      return
    }

    const userId = await getCurrentUserId(this.client)
    await runInBatches(records, async (chunk) => {
      const rows: SyncTableRow[] = chunk.map((record) => ({
        user_id: userId,
        entity: record.entity,
        record_id: record.recordId,
        payload: null,
        updated_at: record.deletedAt,
        deleted_at: record.deletedAt,
        source_client_id: record.sourceClientId,
      }))
      const { error } = await this.client.from(SYNC_TABLE).upsert(rows, {
        onConflict: 'user_id,entity,record_id',
      })
      if (error) {
        throw error
      }
    })
  }
}
