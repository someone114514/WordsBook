<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useDictionaryStore } from '../modules/dictionary/dictionaryStore'
import { exportUserData, importUserData } from '../modules/settings/backupService'
import { useSettingsStore } from '../modules/settings/settingsStore'
import { getWordbookStats } from '../modules/wordbook/wordbookService'

const settingsStore = useSettingsStore()
const dictionaryStore = useDictionaryStore()

const { settings } = storeToRefs(settingsStore)
const { installedMeta, installing, progress, lastError } = storeToRefs(dictionaryStore)

const message = ref('')
const wordbookStats = ref({ total: 0, active: 0 })

const installProgressText = computed(() => {
  if (!progress.value) {
    return ''
  }

  return `${progress.value.message} (${Math.floor(progress.value.ratio * 100)}%)`
})

onMounted(async () => {
  await Promise.all([settingsStore.initialize(), dictionaryStore.refreshInstalledMeta(), refreshStats()])
})

async function refreshStats() {
  wordbookStats.value = await getWordbookStats()
}

async function onUpdateBoolean(key: 'autoPronunciation', event: Event) {
  const target = event.target as HTMLInputElement
  await settingsStore.update({ [key]: target.checked })
}

async function onUpdateNumber(
  key: 'dailyNewLimit' | 'dailyReviewLimit' | 'speechRate',
  event: Event,
): Promise<void> {
  const target = event.target as HTMLInputElement
  const value = Number(target.value)
  if (!Number.isFinite(value)) {
    return
  }

  await settingsStore.update({ [key]: value })
}

async function onUpdateString(
  key: 'deepseekApiKey' | 'deepseekBaseUrl' | 'deepseekModel',
  event: Event,
): Promise<void> {
  const target = event.target as HTMLInputElement
  await settingsStore.update({ [key]: target.value.trim() })
}

async function onInstallDictionary() {
  await dictionaryStore.installDefaultDictionary()
}

async function onExport() {
  const blob = await exportUserData()
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `wordsbook-backup-${new Date().toISOString().slice(0, 10)}.json`
  anchor.click()
  URL.revokeObjectURL(url)
  message.value = '备份文件已导出'
}

async function onImport(event: Event) {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]

  if (!file) {
    return
  }

  const report = await importUserData(file)
  await Promise.all([settingsStore.initialize(), refreshStats()])

  message.value = `导入完成：${report.importedWordbook} 个单词，${report.importedReviewLogs} 条复习日志`
  target.value = ''
}
</script>

<template>
  <section class="panel">
    <p v-if="message" class="success">{{ message }}</p>

    <article class="result-section">
      <h2>词典</h2>
      <p v-if="installedMeta" class="muted">
        当前版本 {{ installedMeta.version }}，词条 {{ installedMeta.entryCount }}
      </p>
      <p v-else class="muted">尚未安装词典</p>
      <button class="btn btn-primary" :disabled="installing" @click="onInstallDictionary">
        {{ installing ? '安装中...' : '安装/更新混合词典' }}
      </button>
      <p v-if="installProgressText" class="muted">{{ installProgressText }}</p>
      <p v-if="lastError" class="error">{{ lastError }}</p>
    </article>

    <article class="result-section">
      <h2>背诵设置</h2>
      <label class="setting-row">
        <span>自动播放发音</span>
        <input
          type="checkbox"
          :checked="settings.autoPronunciation"
          @change="onUpdateBoolean('autoPronunciation', $event)"
        />
      </label>

      <label class="setting-row">
        <span>语速 {{ settings.speechRate.toFixed(1) }}</span>
        <input
          type="range"
          min="0.7"
          max="1.3"
          step="0.1"
          :value="settings.speechRate"
          @input="onUpdateNumber('speechRate', $event)"
        />
      </label>

      <label class="setting-row">
        <span>每日新词上限</span>
        <input
          type="number"
          min="0"
          max="200"
          :value="settings.dailyNewLimit"
          @change="onUpdateNumber('dailyNewLimit', $event)"
        />
      </label>

      <label class="setting-row">
        <span>每日复习上限</span>
        <input
          type="number"
          min="0"
          max="500"
          :value="settings.dailyReviewLimit"
          @change="onUpdateNumber('dailyReviewLimit', $event)"
        />
      </label>
    </article>

    <article class="result-section">
      <h2>AI 词典增强（Deepseek）</h2>
      <label class="setting-stack">
        <span>API Key</span>
        <input
          type="password"
          class="inline-input"
          :value="settings.deepseekApiKey"
          placeholder="sk-..."
          @change="onUpdateString('deepseekApiKey', $event)"
        />
      </label>

      <label class="setting-stack">
        <span>Base URL</span>
        <input
          type="text"
          class="inline-input"
          :value="settings.deepseekBaseUrl"
          @change="onUpdateString('deepseekBaseUrl', $event)"
        />
      </label>

      <label class="setting-stack">
        <span>Model</span>
        <input
          type="text"
          class="inline-input"
          :value="settings.deepseekModel"
          @change="onUpdateString('deepseekModel', $event)"
        />
      </label>

      <p class="muted">查词页支持：AI 追加释义、AI 替换释义、回退 AI、查不到时 AI 加词。</p>
    </article>

    <article class="result-section">
      <h2>数据与备份</h2>
      <p class="muted">单词总数：{{ wordbookStats.total }}，活跃：{{ wordbookStats.active }}</p>
      <div class="actions">
        <button class="btn" @click="onExport">导出备份</button>
        <label class="btn">
          导入备份
          <input type="file" accept="application/json" class="file-input" @change="onImport" />
        </label>
      </div>
    </article>
  </section>
</template>
