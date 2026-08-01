import { computed, readonly, ref } from 'vue'

type UpdateServiceWorker = (reloadPage?: boolean) => Promise<void>

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

const standalone = ref(false)
const online = ref(true)
const keyboardInset = ref(0)
const needRefresh = ref(false)
const offlineReady = ref(false)
const canInstall = ref(false)
const criticalActivities = ref<string[]>([])
let initialized = false
let updateServiceWorker: UpdateServiceWorker | undefined
let installPrompt: BeforeInstallPromptEvent | undefined

export function calculateKeyboardInset(
  layoutHeight: number,
  viewportHeight: number,
  viewportOffsetTop: number,
): number {
  if (![layoutHeight, viewportHeight, viewportOffsetTop].every(Number.isFinite)) return 0
  return Math.max(0, Math.round(layoutHeight - viewportHeight - viewportOffsetTop))
}

export function detectStandaloneMode(
  mediaMatches = typeof window !== 'undefined' && window.matchMedia('(display-mode: standalone)').matches,
  iosStandalone = typeof navigator !== 'undefined'
    && Boolean((navigator as Navigator & { standalone?: boolean }).standalone),
): boolean {
  return mediaMatches || iosStandalone
}

function updateViewportMetrics(): void {
  const viewport = window.visualViewport
  keyboardInset.value = viewport
    ? calculateKeyboardInset(window.innerHeight, viewport.height, viewport.offsetTop)
    : 0
  document.documentElement.style.setProperty('--app-keyboard-inset', `${keyboardInset.value}px`)
  document.documentElement.classList.toggle('app-keyboard-open', keyboardInset.value >= 80)
}

export function initializeAppLifecycle(): void {
  if (initialized || typeof window === 'undefined') return
  initialized = true
  standalone.value = detectStandaloneMode()
  online.value = navigator.onLine
  updateViewportMetrics()

  window.addEventListener('online', () => {
    online.value = true
    window.dispatchEvent(new CustomEvent('wordsbook:network-restored'))
  })
  window.addEventListener('offline', () => { online.value = false })
  window.addEventListener('resize', updateViewportMetrics, { passive: true })
  window.visualViewport?.addEventListener('resize', updateViewportMetrics, { passive: true })
  window.visualViewport?.addEventListener('scroll', updateViewportMetrics, { passive: true })
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault()
    installPrompt = event as BeforeInstallPromptEvent
    canInstall.value = true
  })
  window.addEventListener('appinstalled', () => {
    installPrompt = undefined
    canInstall.value = false
    standalone.value = true
  })
}

export function configureServiceWorkerUpdate(update: UpdateServiceWorker): void {
  updateServiceWorker = update
}

export function setServiceWorkerRefreshAvailable(value: boolean): void {
  needRefresh.value = value
}

export function setOfflineReady(value: boolean): void {
  offlineReady.value = value
}

export function deferServiceWorkerUpdate(): void {
  needRefresh.value = false
}

export function setCriticalActivity(key: string, active: boolean): void {
  const activities = new Set(criticalActivities.value)
  if (active) activities.add(key)
  else activities.delete(key)
  criticalActivities.value = [...activities]
}

export async function applyServiceWorkerUpdate(): Promise<boolean> {
  if (!updateServiceWorker || criticalActivities.value.length) return false
  await updateServiceWorker(true)
  needRefresh.value = false
  return true
}

export async function promptInstall(): Promise<boolean> {
  if (!installPrompt) return false
  await installPrompt.prompt()
  const choice = await installPrompt.userChoice
  if (choice.outcome === 'accepted') {
    installPrompt = undefined
    canInstall.value = false
    return true
  }
  return false
}

export function useAppLifecycle() {
  return {
    standalone: readonly(standalone),
    online: readonly(online),
    keyboardInset: readonly(keyboardInset),
    keyboardOpen: computed(() => keyboardInset.value >= 80),
    needRefresh: readonly(needRefresh),
    offlineReady: readonly(offlineReady),
    canInstall: readonly(canInstall),
    updateBlocked: computed(() => criticalActivities.value.length > 0),
    updateBlockReason: computed(() => criticalActivities.value[0] ?? ''),
    applyServiceWorkerUpdate,
    deferServiceWorkerUpdate,
    promptInstall,
  }
}
