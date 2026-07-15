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
let recoveryPromise: Promise<void> | null = null
let lastRecoveryAt = 0

async function clearRejectedSession(): Promise<void> {
  const client = getSupabaseClient()
  if (!client) return
  // A used/expired refresh token cannot authorize a global sign-out. Local
  // cleanup stops the 30-second retry loop and lets the user log in again.
  await client.auth.signOut({ scope: 'local' })
}

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

  const { data, error } = await client.auth.getSession()
  if (error) {
    await clearRejectedSession()
    return emptyState(true)
  }
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

export async function signUpCloud(email: string, password: string): Promise<{
  auth: CloudAuthState
  confirmationRequired: boolean
}> {
  const client = getSupabaseClient()
  if (!client) throw new Error('未配置 Supabase URL 或 Publishable Key')
  const { data, error } = await client.auth.signUp({ email, password })
  if (error) throw error
  return {
    auth: data.session?.user ? userToState(data.session.user) : emptyState(true),
    confirmationRequired: !data.session,
  }
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

    const now = Date.now()
    if (recoveryPromise || now - lastRecoveryAt < 60_000) return
    lastRecoveryAt = now
    recoveryPromise = client.auth.getSession()
      .then(async ({ error }) => {
        if (error) await clearRejectedSession()
      })
      .catch(() => {
        // Keep local-first mode alive when iOS resumes with a flaky network.
      })
      .finally(() => { recoveryPromise = null })
  }

  window.addEventListener('pageshow', recover)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      recover()
    }
  })
  recover()
}
