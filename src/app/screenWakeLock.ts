interface WakeLockSentinelLike extends EventTarget {
  released: boolean
  release(): Promise<void>
}

interface NavigatorWithWakeLock {
  wakeLock?: {
    request(type: 'screen'): Promise<WakeLockSentinelLike>
  }
}

let sentinel: WakeLockSentinelLike | undefined
const owners = new Set<string>()

async function requestWakeLock(): Promise<void> {
  if (!owners.size || document.visibilityState !== 'visible' || sentinel && !sentinel.released) return
  try {
    sentinel = await (navigator as NavigatorWithWakeLock).wakeLock?.request('screen')
    sentinel?.addEventListener('release', () => { sentinel = undefined }, { once: true })
  } catch {
    sentinel = undefined
  }
}

async function releaseWakeLock(): Promise<void> {
  const active = sentinel
  sentinel = undefined
  await active?.release().catch(() => undefined)
}

export async function setWakeLockOwner(owner: string, active: boolean): Promise<void> {
  if (active) owners.add(owner)
  else owners.delete(owner)
  if (owners.size) await requestWakeLock()
  else await releaseWakeLock()
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void requestWakeLock()
    else void releaseWakeLock()
  })
}
