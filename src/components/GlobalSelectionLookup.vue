<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { DictionaryEntry, StudyList } from '../types/models'
import { lookupWord } from '../modules/dictionary/dictionaryService'
import { playEntryPronunciation } from '../modules/dictionary/audioService'
import { parseSenseRecords } from '../modules/dictionary/senseRecords'
import { loadSettings } from '../modules/settings/settingsService'
import { addEntryToStudyList, listStudyLists, LOOKUP_LIST_ID } from '../modules/wordbook/studyListService'
import {
  canLookupSelectionFrom,
  normalizeLookupSelection,
  selectionElement,
} from '../modules/dictionary/selectionLookup'

const route = useRoute()
const router = useRouter()
const selectedText = ref('')
const selectedEntry = ref<DictionaryEntry | null>(null)
const loading = ref(false)
const message = ref('')
const messageType = ref<'success' | 'error'>('success')
const studyLists = ref<StudyList[]>([])
const selectedListId = ref('')
const choosingList = ref(false)
const actionBusy = ref(false)
const definitionLanguage = ref<'adaptive' | 'english-first' | 'chinese-first'>('adaptive')
const articleLevel = ref<'A2' | 'B1' | 'B2' | 'C1'>('B2')
let lookupToken = 0
let selectionTimer = 0
let panelInteractionUntil = 0

const summary = computed(() => {
  if (!selectedEntry.value) return '本地词典暂无释义，可打开完整查词'
  const sense = parseSenseRecords(selectedEntry.value)[0]
  if (!sense) return '已有本地词条'
  const preferChinese = definitionLanguage.value === 'chinese-first'
    || (definitionLanguage.value === 'adaptive' && (articleLevel.value === 'A2' || articleLevel.value === 'B1'))
  return preferChinese
    ? sense.glossZh || sense.definitionEn || '已有本地词条'
    : sense.definitionEn || sense.glossZh || '已有本地词条'
})

function clearNativeSelection(): void {
  window.getSelection()?.removeAllRanges()
}

function clearSelection(removeNative = true): void {
  window.clearTimeout(selectionTimer)
  lookupToken += 1
  selectedText.value = ''
  selectedEntry.value = null
  loading.value = false
  message.value = ''
  choosingList.value = false
  if (removeNative) clearNativeSelection()
}

async function commitCurrentSelection(): Promise<void> {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) {
    if (
      Date.now() < panelInteractionUntil
      || document.activeElement?.closest('.selection-lookup-panel')
    ) return
    if (selectedText.value) clearSelection(false)
    return
  }
  const range = selection.getRangeAt(0)
  const element = selectionElement(range.commonAncestorContainer)
  const text = normalizeLookupSelection(selection.toString())
  if (!text || !canLookupSelectionFrom(element)) {
    if (selectedText.value) clearSelection(false)
    return
  }
  if (text === selectedText.value && (loading.value || selectedEntry.value)) return

  const token = ++lookupToken
  selectedText.value = text
  selectedEntry.value = null
  message.value = ''
  choosingList.value = false
  loading.value = true
  try {
    const result = await lookupWord(text)
    if (token !== lookupToken) return
    selectedEntry.value = result.exactMatches[0] ?? result.lemmaMatches[0] ?? null
  } catch (error) {
    if (token !== lookupToken) return
    messageType.value = 'error'
    message.value = error instanceof Error ? error.message : '查词失败，请打开完整查词重试'
  } finally {
    if (token === lookupToken) loading.value = false
  }
}

function scheduleSelectionLookup(): void {
  window.clearTimeout(selectionTimer)
  selectionTimer = window.setTimeout(() => void commitCurrentSelection(), 180)
}

function holdPanelInteraction(): void {
  panelInteractionUntil = Date.now() + 500
}

function guardSelectionClick(event: MouseEvent): void {
  const target = event.target instanceof Element ? event.target : null
  if (!target || target.closest('.selection-lookup-panel')) return
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || !normalizeLookupSelection(selection.toString())) return
  if (target.closest('button, a, [role="button"]')) {
    event.preventDefault()
    event.stopImmediatePropagation()
  }
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && selectedText.value) clearSelection()
}

async function openFullLookup(): Promise<void> {
  if (!selectedText.value) return
  const returnTo = route.fullPath
  const query = selectedText.value
  clearSelection()
  await router.push({ path: '/lookup', query: { q: query, from: 'selection', returnTo } })
}

async function playPronunciation(): Promise<void> {
  if (!selectedEntry.value) {
    messageType.value = 'error'
    message.value = '本地词典暂无发音信息，请打开完整查词'
    return
  }
  actionBusy.value = true
  try {
    const result = await playEntryPronunciation(selectedEntry.value)
    if (result.success) return
    messageType.value = 'error'
    message.value = '当前设备无法播放发音'
  } catch (error) {
    messageType.value = 'error'
    message.value = error instanceof Error ? error.message : '播放发音失败'
  } finally {
    actionBusy.value = false
  }
}

async function addSelectedWord(listId = selectedListId.value): Promise<void> {
  if (actionBusy.value) return
  if (!selectedEntry.value) {
    messageType.value = 'error'
    message.value = '本地词典暂未找到，打开完整查词后可补全并加入'
    return
  }
  if (!listId) {
    choosingList.value = true
    return
  }
  actionBusy.value = true
  try {
    const source = route.path.startsWith('/review/reading') ? 'article' : 'lookup'
    await addEntryToStudyList(listId, selectedEntry.value, source)
    window.localStorage.setItem('wordsbook:last-study-list', listId)
    messageType.value = 'success'
    message.value = `已加入「${studyLists.value.find((list) => list.listId === listId)?.name ?? '词表'}」`
  } catch (error) {
    messageType.value = 'error'
    message.value = error instanceof Error ? error.message : '加入词表失败，请重试'
  } finally {
    actionBusy.value = false
  }
}

async function saveSelectedWord(): Promise<void> {
  if (actionBusy.value) return
  if (!selectedEntry.value) {
    await openFullLookup()
    return
  }
  actionBusy.value = true
  try {
    const source = route.path.startsWith('/review/reading') ? 'article' : 'lookup'
    await addEntryToStudyList(LOOKUP_LIST_ID, selectedEntry.value, source)
    messageType.value = 'success'
    message.value = '已仅保存，不进入每日学习'
  } catch (error) {
    messageType.value = 'error'
    message.value = error instanceof Error ? error.message : '保存失败，请重试'
  } finally {
    actionBusy.value = false
  }
}

async function initialize(): Promise<void> {
  const [lists, settings] = await Promise.all([listStudyLists(), loadSettings()])
  studyLists.value = lists.filter((list) => list.systemType !== 'lookup')
  const last = window.localStorage.getItem('wordsbook:last-study-list')
  selectedListId.value = studyLists.value.find((list) => list.listId === last)?.listId
    ?? studyLists.value.find((list) => list.studyEnabled)?.listId
    ?? studyLists.value[0]?.listId
    ?? ''
  definitionLanguage.value = settings.definitionLanguage
  articleLevel.value = settings.articleLevel
}

watch(() => route.fullPath, () => clearSelection())

onMounted(() => {
  void initialize()
  document.addEventListener('selectionchange', scheduleSelectionLookup)
  document.addEventListener('pointerup', scheduleSelectionLookup)
  document.addEventListener('keyup', scheduleSelectionLookup)
  document.addEventListener('click', guardSelectionClick, true)
  document.addEventListener('keydown', handleKeydown)
})

onBeforeUnmount(() => {
  window.clearTimeout(selectionTimer)
  document.removeEventListener('selectionchange', scheduleSelectionLookup)
  document.removeEventListener('pointerup', scheduleSelectionLookup)
  document.removeEventListener('keyup', scheduleSelectionLookup)
  document.removeEventListener('click', guardSelectionClick, true)
  document.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <Teleport to="body">
    <aside
      v-if="selectedText"
      class="selection-lookup-panel reading-selection-bar"
      aria-label="选中内容查词"
      aria-live="polite"
      data-selection-lookup="off"
      @pointerdown.capture="holdPanelInteraction"
      @focusin="holdPanelInteraction"
    >
      <div class="selection-word-summary">
        <strong>{{ selectedText }}</strong>
        <span v-if="loading" class="muted">正在查词…</span>
        <span v-else class="muted">{{ summary }}</span>
        <button class="selection-close" type="button" aria-label="关闭选词查词" @click="clearSelection()">×</button>
      </div>
      <div v-if="choosingList" class="selection-list-picker">
        <select v-model="selectedListId" aria-label="选择学习词表">
          <option v-for="list in studyLists" :key="list.listId" :value="list.listId">{{ list.name }}</option>
        </select>
        <button class="btn btn-primary" type="button" :disabled="actionBusy" @click="addSelectedWord()">确认加入</button>
      </div>
      <div class="selection-actions selection-actions-global">
        <button class="btn" type="button" @click="openFullLookup">完整查词</button>
        <button class="btn" type="button" :disabled="loading || actionBusy || !selectedEntry" @click="playPronunciation">播放发音</button>
        <button class="btn btn-primary" type="button" :disabled="loading || actionBusy" @click="addSelectedWord()">加入学习</button>
        <button class="btn" type="button" :disabled="loading || actionBusy" @click="choosingList = !choosingList">选择词表</button>
        <button class="btn btn-quiet" type="button" :disabled="loading || actionBusy" @click="saveSelectedWord">仅保存</button>
      </div>
      <p v-if="message" :class="[messageType, 'selection-message']" role="status">{{ message }}</p>
    </aside>
  </Teleport>
</template>
