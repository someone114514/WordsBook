import { db } from '../../db/database'
import { getSupabaseClient } from './supabaseClient'

const PROVIDER = 'deepseek'
const ACTIVE_KEY = 'deepseekApiKey'
const accountKey = (userId: string) => `${ACTIVE_KEY}:${userId}`

async function requireUser() {
  const client = getSupabaseClient()
  if (!client) throw new Error('Supabase 尚未配置')
  const { data, error } = await client.auth.getUser()
  if (error || !data.user) throw new Error('请先登录云同步账号')
  return { client, user: data.user }
}

export async function syncDeepseekSecret(): Promise<string> {
  const { client, user } = await requireUser()
  const [{ data, error }, active, account] = await Promise.all([
    client.from('wordsbook_user_secrets').select('secret_value, updated_at').eq('provider', PROVIDER).maybeSingle(),
    db.localSecrets.get(ACTIVE_KEY),
    db.localSecrets.get(accountKey(user.id)),
  ])
  if (error) throw error
  const local = account && (!active?.updatedAt || (account.updatedAt ?? '') >= active.updatedAt) ? account : active
  const cloud = data as { secret_value: string; updated_at: string } | null
  if (cloud && (!local?.updatedAt || cloud.updated_at > local.updatedAt)) {
    const row = { key: accountKey(user.id), value: cloud.secret_value, updatedAt: cloud.updated_at }
    await db.localSecrets.bulkPut([row, { ...row, key: ACTIVE_KEY }])
    return cloud.secret_value
  }
  if (local?.value) {
    await uploadDeepseekSecret(local.value)
    await db.localSecrets.put({ ...local, key: accountKey(user.id) })
    return local.value
  }
  return ''
}

export async function uploadDeepseekSecret(value: string): Promise<void> {
  const { client, user } = await requireUser()
  if (!value.trim()) { await deleteDeepseekSecret(); return }
  const updatedAt = new Date().toISOString()
  const { error } = await client.from('wordsbook_user_secrets').upsert({
    user_id: user.id, provider: PROVIDER, secret_value: value.trim(), updated_at: updatedAt,
  }, { onConflict: 'user_id,provider' })
  if (error) throw error
  await db.localSecrets.put({ key: accountKey(user.id), value: value.trim(), updatedAt })
}

export async function deleteDeepseekSecret(): Promise<void> {
  const { client, user } = await requireUser()
  const { error } = await client.from('wordsbook_user_secrets').delete().eq('provider', PROVIDER)
  if (error) throw error
  await db.localSecrets.bulkDelete([ACTIVE_KEY, accountKey(user.id)])
}

export async function unloadDeepseekSecret(userId: string): Promise<void> {
  const account = await db.localSecrets.get(accountKey(userId))
  const active = await db.localSecrets.get(ACTIVE_KEY)
  if (account?.value && active?.value === account.value) await db.localSecrets.delete(ACTIVE_KEY)
}
