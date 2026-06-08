import type { User } from '@supabase/supabase-js'
import { getSupabaseClient, isSupabaseConfigured } from './supabaseClient'

export interface CloudAuthState {
  configured: boolean
  signedIn: boolean
  email: string
  userId: string
  needsLogin: boolean
}

let recoveryStarted = false

function emptyState(configured = isSupabaseConfigured()): CloudAuthState {
  return {
    configured,
    signedIn: false,
    email: '',
    userId: '',
    needsLogin: configured,
  }
}

function userToState(user: User | null): CloudAuthState {
  if (!user) {
    return emptyState(true)
  }

  return {
    configured: true,
    signedIn: true,
    email: user.email ?? '',
    userId: user.id,
    needsLogin: false,
  }
}

export async function getCloudAuthState(): Promise<CloudAuthState> {
  const client = getSupabaseClient()
  if (!client) {
    return emptyState(false)
  }

  const { data } = await client.auth.getSession()
  if (!data.session?.user) {
    return emptyState(true)
  }

  return userToState(data.session.user)
}

export async function signInCloud(email: string, password: string): Promise<CloudAuthState> {
  const client = getSupabaseClient()
  if (!client) {
    throw new Error('未配置 Supabase URL 或 Publishable Key')
  }

  const { data, error } = await client.auth.signInWithPassword({
    email,
    password,
  })
  if (error) {
    throw error
  }

  return userToState(data.user)
}

export async function signOutCloud(): Promise<void> {
  const client = getSupabaseClient()
  if (!client) {
    return
  }

  await client.auth.signOut()
}

export function startCloudSessionRecovery(): void {
  if (recoveryStarted || typeof window === 'undefined') {
    return
  }

  recoveryStarted = true
  const recover = () => {
    const client = getSupabaseClient()
    if (!client) {
      return
    }

    void client.auth.getSession().catch(() => {
      // Keep local-first mode alive even when iOS resumes with a flaky network.
    })
  }

  window.addEventListener('pageshow', recover)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      recover()
    }
  })
  recover()
}
