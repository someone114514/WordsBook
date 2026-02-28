import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { registerSW } from 'virtual:pwa-register'
import './style.css'
import App from './App.vue'
import { router } from './app/router'

registerSW({ immediate: true })

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
