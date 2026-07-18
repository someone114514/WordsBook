import { defineStore } from 'pinia'
import type { DictionaryMeta } from '../../types/models'
import { getInstalledDictionaryMeta } from './dictionaryService'
import { installDictionaryBundle, type InstallProgress } from './dictionaryInstaller'
import { cacheFullDictionaryInBackground, pauseFullDictionaryCache } from './remoteDictionaryCache'

const BASE_URL = import.meta.env.BASE_URL || '/'
const DEFAULT_MANIFESTS = [
  `${BASE_URL}dictionaries/common/manifest.json`,
  `${BASE_URL}dictionaries/default/manifest.json`,
  `${BASE_URL}dictionaries/ecdict-core/manifest.json`,
]

interface DictionaryState {
  installedMeta: DictionaryMeta | null
  installing: boolean
  progress: InstallProgress | null
  lastError: string | null
  refreshingMeta: Promise<void> | null
  lastRefreshAt: number
  fullCacheProgress: number
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
    fullCacheProgress: 0,
  }),
  getters: {
    isInstalled: (state) => state.installedMeta !== null,
  },
  actions: {
    async refreshInstalledMeta() {
      const now = Date.now()
      if (this.installedMeta && this.lastRefreshAt > 0 && now - this.lastRefreshAt < META_REFRESH_TTL_MS) {
        return
      }

      if (!this.refreshingMeta) {
        this.refreshingMeta = (async () => {
          this.installedMeta = (await getInstalledDictionaryMeta()) ?? null
          if (this.installedMeta && typeof window !== 'undefined' && 'caches' in window) {
            void cacheFullDictionaryInBackground((completed, total) => { this.fullCacheProgress = total ? completed / total : 0 }).catch(() => {
              this.fullCacheProgress = 0
            })
          }
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
      this.progress = { stage: 'fetch-manifest', ratio: 0, message: '正在准备高频核心词库' }
      this.lastError = null

      try {
        const meta = await installDictionaryBundle(DEFAULT_MANIFESTS, (progress) => {
          this.progress = progress
        })

        this.installedMeta = meta
        this.lastRefreshAt = Date.now()
        void cacheFullDictionaryInBackground((completed, total) => { this.fullCacheProgress = total ? completed / total : 0 }).catch(() => {
          this.fullCacheProgress = 0
        })
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error)
      } finally {
        this.installing = false
      }
    },
    pauseFullDictionaryDownload() { pauseFullDictionaryCache() },
    resumeFullDictionaryDownload() {
      void cacheFullDictionaryInBackground((completed, total) => { this.fullCacheProgress = total ? completed / total : 0 }).catch(() => {
        this.fullCacheProgress = 0
      })
    },
  },
})
