import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const AUTH_STORAGE_KEY = 'wordsbook-auth-v1'

let client: SupabaseClient | null = null

function getConfig(): { url: string; publishableKey: string } | null {
  const url = import.meta.env.VITE_SUPABASE_URL?.trim()
  const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim()
  if (!url || !publishableKey) {
    return null
  }

  return { url, publishableKey }
}

export function isSupabaseConfigured(): boolean {
  return getConfig() !== null
}

export function getSupabaseClient(): SupabaseClient | null {
  const config = getConfig()
  if (!config) {
    return null
  }

  if (!client) {
    client = createClient(config.url, config.publishableKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storageKey: AUTH_STORAGE_KEY,
      },
    })
  }

  return client
}
