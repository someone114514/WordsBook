import { defineStore } from 'pinia'
import type { AppSettings } from '../../types/models'
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from './settingsService'

interface SettingsState {
  settings: AppSettings
  loaded: boolean
  initializing: Promise<void> | null
}

export const useSettingsStore = defineStore('settings', {
  state: (): SettingsState => ({
    settings: DEFAULT_SETTINGS,
    loaded: false,
    initializing: null,
  }),
  actions: {
    async initialize() {
      if (this.loaded) {
        return
      }

      if (!this.initializing) {
        this.initializing = (async () => {
          this.settings = await loadSettings()
          this.loaded = true
        })().finally(() => {
          this.initializing = null
        })
      }

      await this.initializing
    },
    async update(patch: Partial<AppSettings>) {
      this.settings = await saveSettings(patch)
      this.loaded = true
    },
  },
})
