import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { registerSW } from 'virtual:pwa-register'
import './style.css'
import App from './App.vue'
import { router } from './app/router'
import { startCloudSessionRecovery } from './modules/sync/cloudAuthService'
import { STUDY_DATA_CHANGED_EVENT } from './modules/review/studyDataRevision'
import { scheduleTodayPlanPrewarm } from './modules/review/reviewService'

registerSW({ immediate: true })
startCloudSessionRecovery()

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')

scheduleTodayPlanPrewarm()
window.addEventListener(STUDY_DATA_CHANGED_EVENT, scheduleTodayPlanPrewarm)
