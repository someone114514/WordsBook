<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useRoute } from 'vue-router'
import { ClipboardPaste, Search as SearchIcon, X } from 'lucide-vue-next'
import { notify } from '../app/feedback'
import AppActionSheet from '../components/AppActionSheet.vue'
import type { DictionaryEntry, LookupResult } from '../types/models'
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
import {
  addToWordbook,
  clearWordLearningHistory,
  getWordbookEntryStatus,
  removeFromLookupCollection,
  resetWordForRelearning,
  type WordbookEntryStatus,
} from '../modules/wordbook/wordbookService'
import { addEntryToStudyList, listStudyLists } from '../modules/wordbook/studyListService'

const route = useRoute()

const dictionaryStore = useDictionaryStore()
const settingsStore = useSettingsStore()

const { installedMeta, installing, progress, lastError } = storeToRefs(dictionaryStore)
const { settings } = storeToRefs(settingsStore)

const query = ref('')
const searchInputRef = ref<HTMLInputElement | null>(null)
const loading = ref(false)
const lookupResult = ref<LookupResult | null>(null)
const entryStatusMap = ref(new Map<string, WordbookEntryStatus>())
const message = ref('')
const messageType = ref<'success' | 'error'>('success')
const studyLists = ref<Awaited<ReturnType<typeof listStudyLists>>>([])
const selectedStudyListId = ref('')
const manageEntryId = ref('')
const aiBusyAction = ref<string | null>(null)
const aiBusyNoResult = ref(false)
const deletingEntryId = ref<string | null>(null)
const addingEntryId = ref<string | null>(null)
const relearningEntryId = ref<string | null>(null)
const clearingHistoryEntryId = ref<string | null>(null)
const sectionExpanded = ref<Record<string, boolean>>({})
const pendingAction = ref<{ kind: 'relearn' | 'clear-history' | 'remove-saved'; entry: DictionaryEntry } | null>(null)
const confirmationBusy = ref(false)

const MAX_VISIBLE_ENTRIES = 8
const RESULT_MOTION_THRESHOLD = 24
const PARSE_CACHE_LIMIT = 360
const LOOKUP_DEBOUNCE_MS = 140
let lookupToken = 0
let lookupTimer: number | null = null
const parsedLinesCache = new Map<string, string[]>()

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
const disableResultMotion = computed(() => totalMatchCount.value > RESULT_MOTION_THRESHOLD)
const dictionarySummary = computed(() => {
  if (installing.value) {
    return progress.value?.message ?? '正在安装高频核心词库'
  }
  if (!installedMeta.value) {
    return '词库未安装'
  }

  return `词库 ${installedMeta.value.entryCount.toLocaleString()} 条`
})
const dictionaryProgress = computed(() => Math.round((progress.value?.ratio ?? 0) * 100))
const selectionReturnTo = computed(() => {
  const value = typeof route.query.returnTo === 'string' ? route.query.returnTo : ''
  return value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/lookup') ? value : ''
})
const selectionReturnLabel = computed(() => selectionReturnTo.value.startsWith('/review/reading')
  ? '返回文章'
  : selectionReturnTo.value.startsWith('/review') ? '返回学习' : '返回原页面')
const pendingActionCopy = computed(() => {
  const action = pendingAction.value
  if (!action) return { title: '', consequence: '', label: '', destructive: false }
  if (action.kind === 'relearn') return {
    title: `重新学习「${action.entry.headword}」？`,
    consequence: '这个词会加入今日重学。历史评分和长期记忆状态会保留。',
    label: '加入今日重学',
    destructive: false,
  }
  if (action.kind === 'remove-saved') return {
    title: `取消保存「${action.entry.headword}」？`,
    consequence: '仅从“已保存”中移除，学习词表归属和复习记录不会改变。',
    label: '取消保存',
    destructive: true,
  }
  return {
    title: `清空「${action.entry.headword}」的学习记录？`,
    consequence: 'FSRS 状态、复习历史与语境练习记录会被永久清除；词条和词表归属会保留，并作为新词重新学习。此操作不可撤销。',
    label: '彻底清空并重新学习',
    destructive: true,
  }
})

async function retryDictionaryInstall() {
  await dictionaryStore.installDefaultDictionary()
  if (installedMeta.value && query.value.trim()) scheduleLookup(query.value.trim())
}
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

async function loadEntryStatus(entries: DictionaryEntry[]): Promise<Map<string, WordbookEntryStatus>> {
  return getWordbookEntryStatus(entries.map((entry) => entry.entryId))
}

function clearLookupTimer(): void {
  if (lookupTimer !== null) {
    window.clearTimeout(lookupTimer)
    lookupTimer = null
  }
}

function resetLookupState(): void {
  lookupResult.value = null
  entryStatusMap.value = new Map<string, WordbookEntryStatus>()
  loading.value = false
}

async function performLookup(raw: string, currentToken: number) {
  if (!raw) {
    if (currentToken === lookupToken) {
      resetLookupState()
    }
    return
  }

  loading.value = true
  try {
    const result = await lookupWord(raw)
    if (currentToken !== lookupToken) {
      return
    }

    lookupResult.value = result
    const combinedEntries = [
      ...result.exactMatches,
      ...result.lemmaMatches,
      ...result.prefixMatches,
      ...result.fuzzyMatches,
    ]
    const statusMap = await loadEntryStatus(combinedEntries)
    if (currentToken !== lookupToken) {
      return
    }
    entryStatusMap.value = statusMap
  } catch (error) {
    if (currentToken === lookupToken) {
      lookupResult.value = null
      entryStatusMap.value = new Map<string, WordbookEntryStatus>()
      messageType.value = 'error'
      message.value = error instanceof Error ? error.message : String(error)
    }
  } finally {
    if (currentToken === lookupToken) {
      loading.value = false
    }
  }
}

function scheduleLookup(raw: string): void {
  const currentToken = ++lookupToken
  clearLookupTimer()

  if (!raw) {
    resetLookupState()
    return
  }

  lookupTimer = window.setTimeout(() => {
    lookupTimer = null
    void performLookup(raw, currentToken)
  }, LOOKUP_DEBOUNCE_MS)
}

async function runLookupNow(raw: string): Promise<void> {
  const currentToken = ++lookupToken
  clearLookupTimer()
  await performLookup(raw, currentToken)
}

watch(query, () => {
  sectionExpanded.value = {}
  scheduleLookup(query.value.trim())
})

onMounted(async () => {
  if (typeof route.query.q === 'string' && route.query.q.trim()) query.value = route.query.q.trim()
  await Promise.all([dictionaryStore.refreshInstalledMeta(), settingsStore.initialize()])
  studyLists.value = (await listStudyLists()).filter((list) => list.systemType !== 'lookup')
  const lastListId = window.localStorage.getItem('wordsbook:last-study-list')
  selectedStudyListId.value = studyLists.value.find((list) => list.listId === lastListId)?.listId
    ?? studyLists.value.find((list) => list.studyEnabled)?.listId ?? studyLists.value[0]?.listId ?? ''
  if (!installedMeta.value) {
    await dictionaryStore.installDefaultDictionary()
    if (query.value.trim()) scheduleLookup(query.value.trim())
  }
})

onActivated(async () => {
  if (typeof route.query.q === 'string' && route.query.q.trim() && route.query.q.trim() !== query.value) {
    query.value = route.query.q.trim()
  }
  studyLists.value = (await listStudyLists()).filter((list) => list.systemType !== 'lookup')
  if (!studyLists.value.some((list) => list.listId === selectedStudyListId.value)) {
    selectedStudyListId.value = studyLists.value.find((list) => list.studyEnabled)?.listId ?? studyLists.value[0]?.listId ?? ''
  }
})

onBeforeUnmount(() => {
  lookupToken += 1
  clearLookupTimer()
  parsedLinesCache.clear()
})

function isAdded(entryId: string): boolean {
  return entryStatusMap.value.get(entryId)?.listIds.some((listId) => listId !== 'system:lookup') ?? false
}

function isSaved(entryId: string): boolean {
  return entryStatusMap.value.get(entryId)?.listIds.includes('system:lookup') ?? false
}

function isInSelectedStudyList(entryId: string): boolean {
  return Boolean(selectedStudyListId.value)
    && (entryStatusMap.value.get(entryId)?.listIds.includes(selectedStudyListId.value) ?? false)
}

function toggleEntryManagement(entry: DictionaryEntry): void {
  if (manageEntryId.value === entry.entryId) {
    manageEntryId.value = ''
    return
  }
  manageEntryId.value = entry.entryId
  const memberships = entryStatusMap.value.get(entry.entryId)?.listIds ?? []
  selectedStudyListId.value = studyLists.value.find((list) => !memberships.includes(list.listId))?.listId
    ?? studyLists.value.find((list) => list.studyEnabled)?.listId
    ?? studyLists.value[0]?.listId
    ?? ''
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
  await runLookupNow(query.value.trim())
}

function onClearQuery() {
  query.value = ''
  lookupToken += 1
  clearLookupTimer()
  resetLookupState()
}

async function onAddWord(entryId: string) {
  const result = await addToWordbook(entryId)
  const previous = entryStatusMap.value.get(entryId)
  entryStatusMap.value = new Map(entryStatusMap.value).set(entryId, {
    wordId: result.wordId,
    listIds: [...new Set([...(previous?.listIds ?? []), 'system:lookup'])],
  })
  messageType.value = 'success'
  message.value = result.alreadyExists ? '已保存在“仅保存”中' : '已保存，不会进入每日学习'
}

async function onAddToStudyList(entry: DictionaryEntry) {
  if (!selectedStudyListId.value) {
    messageType.value = 'error'
    message.value = '请先在“词表”页创建学习词表'
    return
  }
  if (isInSelectedStudyList(entry.entryId)) {
    messageType.value = 'success'
    message.value = '这个单词已在所选词表中'
    return
  }
  addingEntryId.value = entry.entryId
  try {
    const wordId = await addEntryToStudyList(selectedStudyListId.value, entry, 'lookup')
    const previous = entryStatusMap.value.get(entry.entryId)
    entryStatusMap.value = new Map(entryStatusMap.value).set(entry.entryId, {
      wordId,
      listIds: [...new Set([...(previous?.listIds ?? []), selectedStudyListId.value])],
    })
    window.localStorage.setItem('wordsbook:last-study-list', selectedStudyListId.value)
    messageType.value = 'success'
    const listName = studyLists.value.find((list) => list.listId === selectedStudyListId.value)?.name ?? '学习词表'
    message.value = `已加入「${listName}」· 将进入每日队列`
    notify(`已加入「${listName}」。`, { tone: 'success' })
    manageEntryId.value = ''
  } catch (error) {
    messageType.value = 'error'
    message.value = error instanceof Error ? `加入失败：${error.message}` : '加入失败，请重试'
  } finally {
    addingEntryId.value = null
  }
}

async function onRelearn(entry: DictionaryEntry) {
  const status = entryStatusMap.value.get(entry.entryId)
  if (!status) return
  const hasLearningList = status.listIds.some((id) => id !== 'system:lookup')
  if (!hasLearningList && !selectedStudyListId.value) {
    messageType.value = 'error'
    message.value = '请先选择一个学习词表'
    manageEntryId.value = entry.entryId
    return
  }
  relearningEntryId.value = entry.entryId
  try {
    await resetWordForRelearning(status.wordId, hasLearningList ? undefined : selectedStudyListId.value)
    if (!hasLearningList && selectedStudyListId.value) {
      entryStatusMap.value = new Map(entryStatusMap.value).set(entry.entryId, {
        ...status,
        listIds: [...new Set([...status.listIds, selectedStudyListId.value])],
      })
    }
    messageType.value = 'success'
    message.value = '已加入今日重学，当前学习页会自动刷新'
    notify(`「${entry.headword}」已加入今日重学。`, { tone: 'success' })
    manageEntryId.value = ''
  } catch (error) {
    messageType.value = 'error'
    message.value = error instanceof Error ? error.message : '重新学习失败，请重试'
  } finally {
    relearningEntryId.value = null
  }
}

async function onClearLearningHistory(entry: DictionaryEntry) {
  const status = entryStatusMap.value.get(entry.entryId)
  if (!status) return
  const hasLearningList = status.listIds.some((id) => id !== 'system:lookup')
  if (!hasLearningList && !selectedStudyListId.value) {
    messageType.value = 'error'
    message.value = '请先选择一个学习词表'
    return
  }
  clearingHistoryEntryId.value = entry.entryId
  try {
    await clearWordLearningHistory(status.wordId, hasLearningList ? undefined : selectedStudyListId.value)
    messageType.value = 'success'
    message.value = '学习记录已清空，已作为新词加入今日学习'
    notify(`「${entry.headword}」已作为新词重新加入学习。`, { tone: 'success' })
    manageEntryId.value = ''
  } catch (error) {
    messageType.value = 'error'
    message.value = error instanceof Error ? error.message : '清空学习记录失败，请重试'
  } finally {
    clearingHistoryEntryId.value = null
  }
}

async function onRemoveWord(entry: DictionaryEntry) {
  const status = entryStatusMap.value.get(entry.entryId)
  if (!status?.listIds.includes('system:lookup')) {
    return
  }

  deletingEntryId.value = entry.entryId
  try {
    await removeFromLookupCollection(status.wordId)
    const nextStatusMap = new Map(entryStatusMap.value)
    const remainingListIds = status.listIds.filter((listId) => listId !== 'system:lookup')
    if (remainingListIds.length) nextStatusMap.set(entry.entryId, { ...status, listIds: remainingListIds })
    else nextStatusMap.delete(entry.entryId)
    entryStatusMap.value = nextStatusMap
    messageType.value = 'success'
    message.value = '已取消仅保存'
    notify(`已取消保存「${entry.headword}」。`, { tone: 'success' })
  } catch (error) {
    messageType.value = 'error'
    message.value = error instanceof Error ? error.message : '取消保存失败，请重试'
  } finally {
    deletingEntryId.value = null
  }
}

function requestEntryAction(kind: 'relearn' | 'clear-history' | 'remove-saved', entry: DictionaryEntry): void {
  pendingAction.value = { kind, entry }
}

async function confirmEntryAction(): Promise<void> {
  const action = pendingAction.value
  if (!action || confirmationBusy.value) return
  confirmationBusy.value = true
  try {
    if (action.kind === 'relearn') await onRelearn(action.entry)
    else if (action.kind === 'clear-history') await onClearLearningHistory(action.entry)
    else await onRemoveWord(action.entry)
    pendingAction.value = null
  } finally {
    confirmationBusy.value = false
  }
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

async function onPasteQuery() {
  try {
    const text = (await navigator.clipboard.readText()).trim()
    if (!text) {
      messageType.value = 'error'
      message.value = '剪贴板为空'
      return
    }
    query.value = text
    searchInputRef.value?.focus()
  } catch {
    messageType.value = 'error'
    message.value = '读取剪贴板失败，请手动粘贴'
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
      context: {
        originalHeadword: entry.headword,
        posList: entry.posList,
        senses: parseJsonArray(entry.sensesJson),
      },
    })

    await applyAiOverrideToEntry({
      entryId: entry.entryId,
      mode,
      draft,
      model: aiConfig.model,
    })

    messageType.value = 'success'
    message.value = mode === 'replace' ? '已替换为 AI 释义（可回退）' : '已追加 AI 释义（可回退）'
    await runLookupNow(query.value.trim())
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
    await runLookupNow(query.value.trim())
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
    await runLookupNow(raw)
  } catch (error) {
    messageType.value = 'error'
    message.value = error instanceof Error ? error.message : String(error)
  } finally {
    aiBusyNoResult.value = false
  }
}

function parseLines(raw: string): string[] {
  const cached = parsedLinesCache.get(raw)
  if (cached) {
    return cached
  }

  const parsed = parseJsonArray(raw)
  parsedLinesCache.set(raw, parsed)
  if (parsedLinesCache.size > PARSE_CACHE_LIMIT) {
    parsedLinesCache.clear()
  }
  return parsed
}
</script>

<template>
  <section class="panel lookup-panel">
    <aside v-if="selectionReturnTo" class="reading-return-banner">
      <span>查词前的页面与学习进度已保留</span>
      <button class="btn" type="button" @click="$router.push(selectionReturnTo)">{{ selectionReturnLabel }}</button>
    </aside>
    <section v-if="!installedMeta" class="dictionary-setup" aria-live="polite">
      <template v-if="installing">
        <h2>正在安装核心词典</h2>
        <p>{{ progress?.message || '正在准备词典文件' }}</p>
        <progress :value="progress?.ratio ?? 0" max="1" />
        <span>{{ dictionaryProgress }}%</span>
      </template>
      <template v-else>
        <h2>词典尚未就绪</h2>
        <p v-if="lastError" class="error" role="alert">{{ lastError }}</p>
        <p v-else>安装高频核心词典后即可查词。</p>
        <button class="btn btn-primary" type="button" @click="retryDictionaryInstall">安装核心词典</button>
      </template>
    </section>
    <Transition name="soft-fade-slide">
      <p
        v-if="message"
        :class="messageType === 'error' ? 'error' : 'success'"
        :role="messageType === 'error' ? 'alert' : 'status'"
        :aria-live="messageType === 'error' ? 'assertive' : 'polite'"
      >
        {{ message }}
      </p>
    </Transition>

    <section class="result-section lookup-canvas">
      <div class="lookup-canvas-body">
        <Transition name="soft-fade-slide" mode="out-in">
          <div v-if="flowState === 'idle'" key="idle" class="lookup-stage lookup-stage-idle">
            <p class="lookup-stage-center-text">请在下方查询单词，回车即可录入</p>
          </div>

          <div v-else-if="flowState === 'loading'" key="loading" class="lookup-stage lookup-stage-idle">
            <p class="lookup-stage-center-text">检索中...</p>
          </div>

          <div v-else-if="flowState === 'empty'" key="empty" class="lookup-stage lookup-stage-empty">
            <p class="lookup-stage-center-text">没有找到结果</p>
            <div class="actions">
              <button class="btn btn-quiet" :disabled="aiBusyNoResult || !canUseAi" @click="onAiCreateFromQuery">
                {{ aiBusyNoResult ? 'AI 查询中...' : 'AI 查询并加入词典' }}
              </button>
            </div>
            <p v-if="!canUseAi" class="muted">在设置页填写 Deepseek API Key 后可启用 AI 查询。</p>
          </div>

          <div v-else key="results" class="lookup-results-scroll">
            <TransitionGroup :css="!disableResultMotion" name="soft-list" tag="div" class="lookup-results-list">
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

                <TransitionGroup :css="!disableResultMotion" name="soft-list" tag="div" class="entry-list">
                  <div v-for="entry in section.visibleEntries" :key="entry.entryId" class="entry-card">
                    <div class="entry-header">
                      <h3>{{ entry.headword }}</h3>
                      <div class="entry-badges">
                        <span v-if="entry.dictionaryName" class="chip chip-secondary">{{ entry.dictionaryName }}</span>
                        <span v-if="entry.aiEnhanced" class="chip">AI {{ entry.aiEnhanceMode === 'replace' ? '替换' : '增强' }}</span>
                        <span v-if="isAdded(entry.entryId)" class="chip">学习中</span>
                        <span v-else-if="isSaved(entry.entryId)" class="chip chip-secondary">仅保存</span>
                      </div>
                    </div>
                    <p class="muted">{{ entry.phonetic || '无音标' }}</p>
                    <p class="muted">词性: {{ entry.posList.join(' / ') || '-' }}</p>

                    <ul>
                      <li v-for="sense in parseLines(entry.sensesJson)" :key="sense">{{ sense }}</li>
                    </ul>

                    <div
                      v-if="parseLines(entry.synonymsJson ?? '[]').length || parseLines(entry.antonymsJson ?? '[]').length"
                      class="lexical-relations"
                      aria-label="词义关系"
                    >
                      <div v-if="parseLines(entry.synonymsJson ?? '[]').length" class="lexical-relation-row">
                        <strong>近义词</strong>
                        <ul class="lexical-relation-list">
                          <li v-for="synonym in parseLines(entry.synonymsJson ?? '[]')" :key="synonym">{{ synonym }}</li>
                        </ul>
                      </div>
                      <div v-if="parseLines(entry.antonymsJson ?? '[]').length" class="lexical-relation-row">
                        <strong>反义词</strong>
                        <ul class="lexical-relation-list">
                          <li v-for="antonym in parseLines(entry.antonymsJson ?? '[]')" :key="antonym">{{ antonym }}</li>
                        </ul>
                      </div>
                    </div>

                    <p v-for="example in parseLines(entry.examplesJson)" :key="example" class="example">{{ example }}</p>

                    <div class="actions">
                      <button class="btn" @click="onPlay(entry)">发音</button>
                      <button v-if="entryStatusMap.has(entry.entryId)" class="btn lookup-relearn-action" type="button" :disabled="relearningEntryId === entry.entryId" @click="requestEntryAction('relearn', entry)">{{ relearningEntryId === entry.entryId ? '加入中…' : '重新学习' }}</button>
                      <button
                        :class="['btn', 'btn-primary', 'lookup-study-action', { added: isAdded(entry.entryId) }]"
                        type="button"
                        :disabled="addingEntryId === entry.entryId"
                        :aria-pressed="isAdded(entry.entryId)"
                        @click="isAdded(entry.entryId) ? toggleEntryManagement(entry) : onAddToStudyList(entry)"
                      >
                        {{ addingEntryId === entry.entryId ? '加入中…' : isAdded(entry.entryId) ? '已加入学习' : '加入学习' }}
                      </button>
                      <button class="btn btn-quiet" type="button" @click="toggleEntryManagement(entry)">{{ isAdded(entry.entryId) ? '加入其他词表' : '选择词表与更多' }}</button>
                    </div>
                    <div v-if="manageEntryId === entry.entryId" class="lookup-add-panel">
                      <h4>{{ isAdded(entry.entryId) ? '加入其他词表' : '选择学习词表' }}</h4>
                      <select v-if="studyLists.length" v-model="selectedStudyListId" class="inline-input" aria-label="选择学习词表"><option v-for="list in studyLists" :key="list.listId" :value="list.listId" :disabled="entryStatusMap.get(entry.entryId)?.listIds.includes(list.listId)">{{ list.name }}{{ entryStatusMap.get(entry.entryId)?.listIds.includes(list.listId) ? '（已加入）' : '' }}</option></select>
                      <button class="btn btn-primary" :disabled="addingEntryId === entry.entryId || isInSelectedStudyList(entry.entryId)" type="button" @click="onAddToStudyList(entry)">{{ addingEntryId === entry.entryId ? '加入中…' : isInSelectedStudyList(entry.entryId) ? '已在此词表' : '确认加入' }}</button>
                      <hr><p class="muted">只想留作参考，不安排复习？</p>
                      <button v-if="!isSaved(entry.entryId)" class="btn" type="button" @click="onAddWord(entry.entryId)">仅保存</button>
                      <button v-else class="btn btn-danger" :disabled="deletingEntryId === entry.entryId" type="button" @click="requestEntryAction('remove-saved', entry)">{{ deletingEntryId === entry.entryId ? '处理中…' : '取消仅保存' }}</button>
                      <template v-if="entryStatusMap.has(entry.entryId)">
                        <hr><p class="muted">不可撤销的高级操作</p>
                        <button class="btn btn-danger" :disabled="clearingHistoryEntryId === entry.entryId" type="button" @click="requestEntryAction('clear-history', entry)">{{ clearingHistoryEntryId === entry.entryId ? '清空中…' : '彻底清空学习记录' }}</button>
                      </template>
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
                </TransitionGroup>
              </article>
            </TransitionGroup>
          </div>
        </Transition>
      </div>

      <footer class="lookup-canvas-footer">
        <div class="entry-badges">
          <span class="chip chip-secondary">{{ dictionarySummary }}</span>
          <span v-if="flowState === 'results'" class="chip">命中 {{ totalMatchCount }}</span>
        </div>
      </footer>
    </section>

    <form class="lookup-dock lookup-search-strip" @submit.prevent="onLookupSubmit">
      <label class="lookup-search-pill">
        <SearchIcon class="lookup-search-glyph" :size="18" :stroke-width="2" aria-hidden="true" />
        <span class="sr-only">查词输入框</span>
        <input
          ref="searchInputRef"
          v-model="query"
          :disabled="!installedMeta || installing"
          class="search-input"
          type="text"
          placeholder="查询单词"
          autocomplete="off"
          autocapitalize="none"
          autocorrect="off"
          enterkeyhint="search"
          inputmode="search"
          :spellcheck="false"
        />
        <button
          v-if="query"
          type="button"
          class="search-clear-btn"
          aria-label="清空输入"
          @click="onClearQuery"
        >
          <X :size="17" aria-hidden="true" /><span class="sr-only">清空</span>
        </button>
      </label>

      <button type="button" class="quick-action-btn quick-action-btn-soft" @click="onPasteQuery"><ClipboardPaste :size="18" aria-hidden="true" /><span>粘贴</span></button>
      <button type="submit" class="sr-only">查询</button>
    </form>

    <AppActionSheet
      :open="Boolean(pendingAction)"
      :title="pendingActionCopy.title"
      :dismissible="!confirmationBusy"
      @close="pendingAction = null"
    >
      <p>{{ pendingActionCopy.consequence }}</p>
      <template #actions>
        <button class="btn" type="button" :disabled="confirmationBusy" @click="pendingAction = null">取消</button>
        <button :class="['btn', pendingActionCopy.destructive ? 'btn-danger' : 'btn-primary']" type="button" :disabled="confirmationBusy" @click="confirmEntryAction">
          {{ confirmationBusy ? '处理中…' : pendingActionCopy.label }}
        </button>
      </template>
    </AppActionSheet>
  </section>
</template>
