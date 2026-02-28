import { defineStore } from 'pinia'
import type { DictionaryMeta } from '../../types/models'
import { getInstalledDictionaryMeta } from './dictionaryService'
import { installDictionaryBundle, type InstallProgress } from './dictionaryInstaller'

const DEFAULT_MANIFESTS = ['/dictionaries/default/manifest.json', '/dictionaries/common/manifest.json']

interface DictionaryState {
  installedMeta: DictionaryMeta | null
  installing: boolean
  progress: InstallProgress | null
  lastError: string | null
}

export const useDictionaryStore = defineStore('dictionary', {
  state: (): DictionaryState => ({
    installedMeta: null,
    installing: false,
    progress: null,
    lastError: null,
  }),
  getters: {
    isInstalled: (state) => state.installedMeta !== null,
  },
  actions: {
    async refreshInstalledMeta() {
      this.installedMeta = (await getInstalledDictionaryMeta()) ?? null
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
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error)
      } finally {
        this.installing = false
      }
    },
  },
})
