import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { registerSW } from 'virtual:pwa-register'
import './style.css'
import App from './App.vue'
import { router } from './app/router'
import { startCloudSessionRecovery } from './modules/sync/cloudAuthService'
import { STUDY_DATA_CHANGED_EVENT } from './modules/review/studyDataRevision'
import { scheduleTodayPlanPrewarm } from './modules/review/reviewService'
import { resumePendingArticlePreload } from './modules/reading/readingService'
import { resumePendingPracticePreload } from './modules/reading/practiceService'
import { reconcileStudyDay } from './modules/review/dailyQueueService'
import { initializePersonalizedReviewScheduler } from './modules/review/fsrsPersonalizationService'

const COI_RELOAD_KEY = 'wordsbook:coi-reload'
let reloadingForIsolation = false
const fsrsTrainingMode = new URL(window.location.href).searchParams.get('fsrs-training') === '1'
if (!fsrsTrainingMode) sessionStorage.removeItem(COI_RELOAD_KEY)

function reloadAfterServiceWorkerControl() {
  if (
    reloadingForIsolation
    || import.meta.env.DEV
    || !fsrsTrainingMode
    || globalThis.crossOriginIsolated
    || sessionStorage.getItem(COI_RELOAD_KEY)
  ) return
  reloadingForIsolation = true
  sessionStorage.setItem(COI_RELOAD_KEY, '1')
  window.location.reload()
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', reloadAfterServiceWorkerControl)
}
registerSW({ immediate: true })
startCloudSessionRecovery()
await initializePersonalizedReviewScheduler().catch(() => undefined)

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')

scheduleTodayPlanPrewarm()
window.addEventListener(STUDY_DATA_CHANGED_EVENT, () => {
  void initializePersonalizedReviewScheduler().catch(() => undefined)
  scheduleTodayPlanPrewarm()
})
void resumePendingArticlePreload().catch(() => undefined)
void resumePendingPracticePreload().catch(() => undefined)
let reconcilePromise: Promise<unknown> | null = null
function reconcileCurrentStudyDay() {
  if (reconcilePromise) return reconcilePromise
  reconcilePromise = reconcileStudyDay()
    .catch(() => undefined)
    .finally(() => { reconcilePromise = null })
  return reconcilePromise
}
void reconcileCurrentStudyDay()
router.afterEach(() => { void reconcileCurrentStudyDay() })

let midnightTimer = 0
function scheduleMidnightReconcile() {
  window.clearTimeout(midnightTimer)
  const now = new Date()
  const next = new Date(now)
  next.setHours(24, 0, 0, 50)
  midnightTimer = window.setTimeout(() => {
    void reconcileCurrentStudyDay()
    scheduleMidnightReconcile()
  }, next.getTime() - now.getTime())
}
scheduleMidnightReconcile()
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    void reconcileCurrentStudyDay()
    void resumePendingArticlePreload().catch(() => undefined)
    void resumePendingPracticePreload().catch(() => undefined)
  }
})
