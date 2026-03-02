<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useRouter } from 'vue-router'
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
const router = useRouter()

const { installedMeta } = storeToRefs(dictionaryStore)
const { settings } = storeToRefs(settingsStore)

const query = ref('')
const loading = ref(false)
const lookupResult = ref<LookupResult | null>(null)
const entryStatusMap = ref(new Map<string, string>())
const message = ref('')
const messageType = ref<'success' | 'error'>('success')
const aiBusyAction = ref<string | null>(null)
const aiBusyNoResult = ref(false)
const sectionExpanded = ref<Record<string, boolean>>({})

const MAX_VISIBLE_ENTRIES = 8

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

const visibleGroupedMatches = computed(() =>
  groupedMatches.value.map((section) => {
    const expanded = Boolean(sectionExpanded.value[section.title])
    const visibleEntries = expanded ? section.entries : section.entries.slice(0, MAX_VISIBLE_ENTRIES)
    return {
      ...section,
      expanded,
      visibleEntries,
      hiddenCount: Math.max(section.entries.length - visibleEntries.length, 0),
    }
  }),
)

const canUseAi = computed(() => settings.value.deepseekApiKey.trim().length > 0)
const totalMatchCount = computed(() =>
  groupedMatches.value.reduce((count, section) => count + section.entries.length, 0),
)
const dictionarySummary = computed(() => {
  if (!installedMeta.value) {
    return '词库未安装'
  }

  return `词库 ${installedMeta.value.entryCount.toLocaleString()} 条`
})
const flowState = computed(() => {
  const hasQuery = query.value.trim().length > 0
  if (!hasQuery) {
    return 'idle'
  }
  if (loading.value) {
    return 'loading'
  }
  if (lookupResult.value && !lookupResult.value.hasResult) {
    return 'empty'
  }
  return 'results'
})

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
}, 180)

watch(query, () => {
  sectionExpanded.value = {}
  void runLookup()
})

onMounted(async () => {
  await Promise.all([dictionaryStore.refreshInstalledMeta(), settingsStore.initialize()])
})

function isAdded(entryId: string): boolean {
  return entryStatusMap.value.has(entryId)
}

function isAiActionBusy(entryId: string, mode: 'add' | 'replace' | 'rollback'): boolean {
  return aiBusyAction.value === `${entryId}:${mode}`
}

function toggleSection(title: string) {
  sectionExpanded.value = {
    ...sectionExpanded.value,
    [title]: !sectionExpanded.value[title],
  }
}

async function onLookupSubmit() {
  sectionExpanded.value = {}
  await performLookup(query.value.trim())
}

function onClearQuery() {
  query.value = ''
}

async function onOpenSettings() {
  await router.push('/settings')
}

async function onAddWord(entryId: string) {
  const result = await addToWordbook(entryId)
  entryStatusMap.value.set(entryId, result.wordId)
  messageType.value = 'success'
  message.value = result.alreadyExists ? '该单词已在单词本中' : '已加入单词本'
}

async function onPlay(entry: DictionaryEntry) {
  const result = await playEntryPronunciation(entry, {
    rate: settings.value.speechRate,
    ttsEngine: settings.value.ttsEngine,
  })
  if (!result.success) {
    messageType.value = 'error'
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

    messageType.value = 'success'
    message.value = mode === 'replace' ? '已替换为 AI 释义（可回退）' : '已追加 AI 释义（可回退）'
    await performLookup(query.value.trim())
  } catch (error) {
    messageType.value = 'error'
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
    messageType.value = 'success'
    message.value = rolledBack ? '已回退到上一个版本' : '没有可回退的 AI 修改'
    await performLookup(query.value.trim())
  } finally {
    aiBusyAction.value = null
  }
}

async function onAiCreateFromQuery() {
  const raw = query.value.trim()
  if (!raw) {
    messageType.value = 'error'
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

    messageType.value = 'success'
    message.value = 'AI 词条已加入本地词典'
    await performLookup(raw)
  } catch (error) {
    messageType.value = 'error'
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
  <section class="panel lookup-panel">
    <section class="result-section lookup-hero">
      <div>
        <strong>极速查词</strong>
        <p class="muted">输入即查，本地优先，结果按命中等级分组</p>
      </div>
      <div class="entry-badges">
        <span class="chip chip-secondary">{{ dictionarySummary }}</span>
        <span v-if="flowState === 'results'" class="chip">本次命中 {{ totalMatchCount }}</span>
      </div>
    </section>

    <div class="lookup-main">
      <p
        v-if="message"
        :class="messageType === 'error' ? 'error' : 'success'"
        :role="messageType === 'error' ? 'alert' : 'status'"
        :aria-live="messageType === 'error' ? 'assertive' : 'polite'"
      >
        {{ message }}
      </p>

      <div class="lookup-flow-panel">
        <div v-if="flowState === 'idle'" class="result-section lookup-stage">
          <p class="muted">请在下方查询单词，回车即可录入</p>
          <div class="lookup-stage-actions">
            <button v-if="!installedMeta" type="button" class="btn btn-quiet" @click="onOpenSettings">
              前往设置安装词库
            </button>
          </div>
        </div>

        <div v-else-if="flowState === 'loading'" class="result-section lookup-stage">
          <p class="muted">检索中...</p>
        </div>

        <div v-else-if="flowState === 'empty'" class="result-section">
          <p class="muted">没有找到结果</p>
          <div class="actions">
            <button class="btn btn-quiet" :disabled="aiBusyNoResult || !canUseAi" @click="onAiCreateFromQuery">
              {{ aiBusyNoResult ? 'AI 查询中...' : 'AI 查询并加入词典' }}
            </button>
            <button v-if="!installedMeta" type="button" class="btn btn-quiet" @click="onOpenSettings">
              去设置安装词库
            </button>
          </div>
          <p v-if="!canUseAi" class="muted">在设置页填写 Deepseek API Key 后可启用 AI 查询。</p>
        </div>

        <div v-else class="lookup-flow-spacer" aria-hidden="true" />
      </div>

      <div v-if="flowState === 'results'" class="lookup-results-list">
        <article v-for="section in visibleGroupedMatches" :key="section.title" class="result-section">
          <div class="result-section-head">
            <h2>
              {{ section.title }}
              <span class="result-count">({{ section.entries.length }})</span>
            </h2>
            <button
              v-if="section.entries.length > MAX_VISIBLE_ENTRIES"
              type="button"
              class="btn btn-quiet section-toggle"
              @click="toggleSection(section.title)"
            >
              {{ section.expanded ? '收起' : `显示更多（+${section.hiddenCount}）` }}
            </button>
          </div>

          <div class="entry-list">
            <div v-for="entry in section.visibleEntries" :key="entry.entryId" class="entry-card">
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

              <details class="ai-details">
                <summary>AI 词义增强</summary>
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
                <p v-if="!canUseAi" class="muted">在设置页填写 Deepseek API Key 后可启用 AI 增强。</p>
              </details>
            </div>
          </div>
        </article>
      </div>
    </div>

    <form class="lookup-search-wrap lookup-dock" @submit.prevent="onLookupSubmit">
      <label class="lookup-search-field">
        <span class="sr-only">查词输入框</span>
        <input
          v-model="query"
          class="search-input"
          type="text"
          placeholder="输入英文单词，如 running"
          autocomplete="off"
          inputmode="search"
        />
        <button
          v-if="query"
          type="button"
          class="search-clear-btn"
          aria-label="清空输入"
          @click="onClearQuery"
        >
          清空
        </button>
      </label>
      <button type="submit" class="btn btn-primary lookup-submit-btn" :disabled="loading || !query.trim()">
        查询
      </button>
    </form>
  </section>
</template>
