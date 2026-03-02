import { defineStore } from 'pinia'
import type { DictionaryMeta } from '../../types/models'
import { getDictionaryHealth } from './dictionaryService'
import { installDictionaryBundle, type InstallProgress } from './dictionaryInstaller'

const BASE_URL = import.meta.env.BASE_URL || '/'
const DEFAULT_MANIFESTS = [
  `${BASE_URL}dictionaries/ecdict/manifest.json`,
  `${BASE_URL}dictionaries/common/manifest.json`,
]

interface DictionaryState {
  installedMeta: DictionaryMeta | null
  installing: boolean
  progress: InstallProgress | null
  lastError: string | null
  refreshingMeta: Promise<void> | null
  lastRefreshAt: number
}

const META_REFRESH_TTL_MS = 30 * 1000

export const useDictionaryStore = defineStore('dictionary', {
  state: (): DictionaryState => ({
    installedMeta: null,
    installing: false,
    progress: null,
    lastError: null,
    refreshingMeta: null,
    lastRefreshAt: 0,
  }),
  getters: {
    isInstalled: (state) => state.installedMeta !== null,
  },
  actions: {
    async refreshInstalledMeta() {
      const now = Date.now()
      if (this.lastRefreshAt > 0 && now - this.lastRefreshAt < META_REFRESH_TTL_MS) {
        return
      }

      if (!this.refreshingMeta) {
        this.refreshingMeta = (async () => {
          const health = await getDictionaryHealth()

          if (health.meta && !health.healthy) {
            // Treat corrupted dictionary as not installed, so install button appears.
            this.installedMeta = null
            this.lastError = `词典数据异常（词条 ${health.entryCount} / 索引 ${health.indexCount}）。请重新安装词典。`
            return
          }

          this.installedMeta = health.meta ?? null
          this.lastError = null
          this.lastRefreshAt = Date.now()
        })().finally(() => {
          this.refreshingMeta = null
        })
      }

      await this.refreshingMeta
    },

    async installDefaultDictionary() {
      this.installing = true
      this.progress = { stage: 'fetch-manifest', ratio: 0, message: 'Preparing mixed dictionaries' }
      this.lastError = null

      try {
        const meta = await installDictionaryBundle(DEFAULT_MANIFESTS, (progress) => {
          this.progress = progress
        })

        this.installedMeta = meta
        this.lastRefreshAt = Date.now()
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error)
      } finally {
        this.installing = false
      }
    },
  },
})
