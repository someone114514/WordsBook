import { defineStore } from 'pinia'
import type { AppSettings } from '../../types/models'
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from './settingsService'

interface SettingsState {
  settings: AppSettings
  loaded: boolean
}

export const useSettingsStore = defineStore('settings', {
  state: (): SettingsState => ({
    settings: DEFAULT_SETTINGS,
    loaded: false,
  }),
  actions: {
    async initialize() {
      this.settings = await loadSettings()
      this.loaded = true
    },
    async update(patch: Partial<AppSettings>) {
      this.settings = await saveSettings(patch)
      this.loaded = true
    },
  },
})
