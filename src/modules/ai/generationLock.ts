const LEASE_MS = 135_000
const LEASE_POLL_MS = 450

function readLease(key: string): { owner: string; expiresAt: number } | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null') as unknown
    if (!value || typeof value !== 'object') return undefined
    const lease = value as { owner?: unknown; expiresAt?: unknown }
    return typeof lease.owner === 'string' && typeof lease.expiresAt === 'number'
      ? { owner: lease.owner, expiresAt: lease.expiresAt }
      : undefined
  } catch { return undefined }
}

function tabOwner(): string {
  const key = 'wordsbook:generation-tab-owner'
  try {
    const stored = sessionStorage.getItem(key)
    if (stored) return stored
    const created = crypto.randomUUID()
    sessionStorage.setItem(key, created)
    return created
  } catch { return crypto.randomUUID() }
}

async function runWithLease<T>(name: string, task: () => Promise<T>): Promise<T> {
  if (typeof localStorage === 'undefined') return await task()
  const key = `wordsbook:lease:${name}`
  // sessionStorage survives a hard refresh but is isolated per tab. The new
  // page can therefore reclaim its own interrupted lease immediately, while
  // another tab still waits for the active owner.
  const owner = tabOwner()
  const deadline = Date.now() + LEASE_MS
  while (Date.now() < deadline) {
    const current = readLease(key)
    if (!current || current.owner === owner || current.expiresAt <= Date.now()) {
      try {
        localStorage.setItem(key, JSON.stringify({ owner, expiresAt: Date.now() + LEASE_MS }))
        if (readLease(key)?.owner === owner) {
          try { return await task() }
          finally {
            if (readLease(key)?.owner === owner) localStorage.removeItem(key)
          }
        }
      } catch { return await task() }
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, LEASE_POLL_MS))
  }
  return await task()
}

export async function runWithGenerationLock<T>(name: string, task: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return await navigator.locks.request(name, async () => await task())
  }
  return await runWithLease(name, task)
}
