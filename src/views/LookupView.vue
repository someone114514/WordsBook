<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import type { DictionaryEntry, LookupResult } from '../types/models'
import { debounce } from '../utils/debounce'
import { parseJsonArray } from '../utils/json'
import { playEntryPronunciation } from '../modules/dictionary/audioService'
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

async function refreshEntryStatus(entries: DictionaryEntry[]) {
  const map = await getWordbookEntryStatus(entries.map((entry) => entry.entryId))
  entryStatusMap.value = map
}

const runLookup = debounce(async () => {
  const raw = query.value.trim()

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

async function onAddWord(entryId: string) {
  const result = await addToWordbook(entryId)
  entryStatusMap.value.set(entryId, result.wordId)
  message.value = result.alreadyExists ? '该单词已在单词本中' : '已加入单词本'
}

async function onPlay(entry: DictionaryEntry) {
  await playEntryPronunciation(entry, settings.value.speechRate)
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
    <p v-else-if="lookupResult && !lookupResult.hasResult" class="muted">没有找到结果</p>

    <article v-for="section in groupedMatches" :key="section.title" class="result-section">
      <h2>{{ section.title }}</h2>

      <div v-for="entry in section.entries" :key="entry.entryId" class="entry-card">
        <div class="entry-header">
          <h3>{{ entry.headword }}</h3>
          <div class="entry-badges">
            <span v-if="entry.dictionaryName" class="chip chip-secondary">{{ entry.dictionaryName }}</span>
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
      </div>
    </article>
  </section>
</template>
