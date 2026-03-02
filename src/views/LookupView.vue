<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import type { DictionaryEntry, LookupResult } from '../types/models'
import { debounce } from '../utils/debounce'
import { parseJsonArray } from '../utils/json'
import { playEntryPronunciation } from '../modules/dictionary/audioService'
import {
  applyAiOverrideToEntry,
  createOrReplaceAiEntry,
  fetchAiDictionaryDraft,
  rollbackAiOverride,
} from '../modules/dictionary/aiDefinitionService'
import { lookupWord } from '../modules/dictionary/dictionaryService'
import { useDictionaryStore } from '../modules/dictionary/dictionaryStore'
import { useSettingsStore } from '../modules/settings/settingsStore'
import { addToWordbook, getWordbookEntryStatus } from '../modules/wordbook/wordbookService'

const dictionaryStore = useDictionaryStore()
const settingsStore = useSettingsStore()

const { installedMeta, installing, progress, lastError } = storeToRefs(dictionaryStore)
const { settings } = storeToRefs(settingsStore)

const query = ref('')
const loading = ref(false)
const lookupResult = ref<LookupResult | null>(null)
const entryStatusMap = ref(new Map<string, string>())
const message = ref('')
const aiBusyAction = ref<string | null>(null)
const aiBusyNoResult = ref(false)

const groupedMatches = computed(() => {
  if (!lookupResult.value) {
    return []
  }

  return [
    { title: '精确匹配', entries: lookupResult.value.exactMatches },
    { title: '词形还原', entries: lookupResult.value.lemmaMatches },
    { title: '前缀候选', entries: lookupResult.value.prefixMatches },
    { title: '模糊匹配', entries: lookupResult.value.fuzzyMatches },
  ].filter((section) => section.entries.length > 0)
})

const canUseAi = computed(() => settings.value.deepseekApiKey.trim().length > 0)

function getAiConfig() {
  const apiKey = settings.value.deepseekApiKey.trim()
  if (!apiKey) {
    throw new Error('请先在设置页填写 Deepseek API Key')
  }

  return {
    apiKey,
    baseUrl: settings.value.deepseekBaseUrl.trim(),
    model: settings.value.deepseekModel.trim(),
  }
}

async function refreshEntryStatus(entries: DictionaryEntry[]) {
  const map = await getWordbookEntryStatus(entries.map((entry) => entry.entryId))
  entryStatusMap.value = map
}

async function performLookup(raw: string) {
  if (!raw) {
    lookupResult.value = null
    entryStatusMap.value = new Map<string, string>()
    return
  }

  loading.value = true
  try {
    const result = await lookupWord(raw)
    lookupResult.value = result
    await refreshEntryStatus([
      ...result.exactMatches,
      ...result.lemmaMatches,
      ...result.prefixMatches,
      ...result.fuzzyMatches,
    ])
  } finally {
    loading.value = false
  }
}

const runLookup = debounce(async () => {
  await performLookup(query.value.trim())
}, 250)

watch(query, () => {
  void runLookup()
})

onMounted(async () => {
  await Promise.all([dictionaryStore.refreshInstalledMeta(), settingsStore.initialize()])
})

async function installDictionaryNow() {
  await dictionaryStore.installDefaultDictionary()
}

function isAdded(entryId: string): boolean {
  return entryStatusMap.value.has(entryId)
}

function isAiActionBusy(entryId: string, mode: 'add' | 'replace' | 'rollback'): boolean {
  return aiBusyAction.value === `${entryId}:${mode}`
}

async function onAddWord(entryId: string) {
  const result = await addToWordbook(entryId)
  entryStatusMap.value.set(entryId, result.wordId)
  message.value = result.alreadyExists ? '该单词已在单词本中' : '已加入单词本'
}

async function onPlay(entry: DictionaryEntry) {
  const result = await playEntryPronunciation(entry, {
    rate: settings.value.speechRate,
    ttsEngine: settings.value.ttsEngine,
  })
  if (!result.success) {
    message.value = '发音失败：当前设备语音服务不可用'
  }
}

async function onAiEnhance(entry: DictionaryEntry, mode: 'add' | 'replace') {
  const actionKey = `${entry.entryId}:${mode}`
  aiBusyAction.value = actionKey

  try {
    const aiConfig = getAiConfig()
    const draft = await fetchAiDictionaryDraft({
      word: entry.headword,
      apiKey: aiConfig.apiKey,
      baseUrl: aiConfig.baseUrl,
      model: aiConfig.model,
    })

    await applyAiOverrideToEntry({
      entryId: entry.entryId,
      mode,
      draft,
      model: aiConfig.model,
    })

    message.value = mode === 'replace' ? '已替换为 AI 释义（可回退）' : '已追加 AI 释义（可回退）'
    await performLookup(query.value.trim())
  } catch (error) {
    message.value = error instanceof Error ? error.message : String(error)
  } finally {
    aiBusyAction.value = null
  }
}

async function onAiRollback(entry: DictionaryEntry) {
  const actionKey = `${entry.entryId}:rollback`
  aiBusyAction.value = actionKey

  try {
    const rolledBack = await rollbackAiOverride(entry.entryId)
    message.value = rolledBack ? '已回退到上一个版本' : '没有可回退的 AI 修改'
    await performLookup(query.value.trim())
  } finally {
    aiBusyAction.value = null
  }
}

async function onAiCreateFromQuery() {
  const raw = query.value.trim()
  if (!raw) {
    message.value = '请先输入单词'
    return
  }

  aiBusyNoResult.value = true
  try {
    const aiConfig = getAiConfig()
    const draft = await fetchAiDictionaryDraft({
      word: raw,
      apiKey: aiConfig.apiKey,
      baseUrl: aiConfig.baseUrl,
      model: aiConfig.model,
    })

    await createOrReplaceAiEntry({
      query: raw,
      draft,
    })

    message.value = 'AI 词条已加入本地词典'
    await performLookup(raw)
  } catch (error) {
    message.value = error instanceof Error ? error.message : String(error)
  } finally {
    aiBusyNoResult.value = false
  }
}

function parseLines(raw: string): string[] {
  return parseJsonArray(raw)
}
</script>

<template>
  <section class="panel">
    <p class="muted">离线优先查词。首次使用请先安装词典。</p>

    <div v-if="!installedMeta" class="install-card">
      <button class="btn btn-primary" :disabled="installing" @click="installDictionaryNow">
        {{ installing ? '安装中...' : '安装混合词典' }}
      </button>
      <p v-if="progress" class="muted">{{ progress.message }} ({{ Math.floor(progress.ratio * 100) }}%)</p>
      <p v-if="lastError" class="error">{{ lastError }}</p>
    </div>

    <div v-else class="dict-meta">
      <strong>词典版本：</strong>{{ installedMeta.version }}
      <span class="meta-sep">|</span>
      <strong>词条：</strong>{{ installedMeta.entryCount }}
    </div>

    <input
      v-model="query"
      class="search-input"
      type="text"
      placeholder="输入英文单词，如 running"
      autocomplete="off"
    />

    <p v-if="message" class="success">{{ message }}</p>
    <p v-if="loading" class="muted">检索中...</p>

    <div v-else-if="lookupResult && !lookupResult.hasResult" class="result-section">
      <p class="muted">没有找到结果</p>
      <div class="actions">
        <button class="btn btn-quiet" :disabled="aiBusyNoResult || !canUseAi" @click="onAiCreateFromQuery">
          {{ aiBusyNoResult ? 'AI 查询中...' : 'AI 查询并加入词典' }}
        </button>
      </div>
      <p v-if="!canUseAi" class="muted">在设置页填写 Deepseek API Key 后可启用 AI 查询。</p>
    </div>

    <article v-for="section in groupedMatches" :key="section.title" class="result-section">
      <h2>{{ section.title }}</h2>

      <div v-for="entry in section.entries" :key="entry.entryId" class="entry-card">
        <div class="entry-header">
          <h3>{{ entry.headword }}</h3>
          <div class="entry-badges">
            <span v-if="entry.dictionaryName" class="chip chip-secondary">{{ entry.dictionaryName }}</span>
            <span v-if="entry.aiEnhanced" class="chip">AI {{ entry.aiEnhanceMode === 'replace' ? '替换' : '增强' }}</span>
            <span v-if="isAdded(entry.entryId)" class="chip">已加入</span>
          </div>
        </div>
        <p class="muted">{{ entry.phonetic || '无音标' }}</p>
        <p class="muted">词性: {{ entry.posList.join(' / ') || '-' }}</p>

        <ul>
          <li v-for="sense in parseLines(entry.sensesJson)" :key="sense">{{ sense }}</li>
        </ul>

        <p v-for="example in parseLines(entry.examplesJson)" :key="example" class="example">{{ example }}</p>

        <div class="actions">
          <button class="btn" @click="onPlay(entry)">发音</button>
          <button class="btn btn-primary" :disabled="isAdded(entry.entryId)" @click="onAddWord(entry.entryId)">
            {{ isAdded(entry.entryId) ? '已加入' : '加入单词本' }}
          </button>
        </div>

        <div class="actions actions-soft ai-actions">
          <button
            class="btn btn-quiet"
            :disabled="!canUseAi || isAiActionBusy(entry.entryId, 'add')"
            @click="onAiEnhance(entry, 'add')"
          >
            {{ isAiActionBusy(entry.entryId, 'add') ? 'AI处理中...' : 'AI 追加释义' }}
          </button>
          <button
            class="btn btn-quiet"
            :disabled="!canUseAi || isAiActionBusy(entry.entryId, 'replace')"
            @click="onAiEnhance(entry, 'replace')"
          >
            {{ isAiActionBusy(entry.entryId, 'replace') ? 'AI处理中...' : 'AI 替换释义' }}
          </button>
          <button
            class="btn btn-quiet"
            :disabled="!entry.aiEnhanced || isAiActionBusy(entry.entryId, 'rollback')"
            @click="onAiRollback(entry)"
          >
            {{ isAiActionBusy(entry.entryId, 'rollback') ? '回退中...' : '回退 AI' }}
          </button>
        </div>
      </div>
    </article>
  </section>
</template>
