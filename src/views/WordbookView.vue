<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import type { WordbookWithEntry } from '../types/models'
import {
  listWordbookItems,
  removeWordFromWordbook,
  updateWordbookItem,
} from '../modules/wordbook/wordbookService'
import { parseJsonArray } from '../utils/json'

const loading = ref(false)
const rows = ref<WordbookWithEntry[]>([])
const query = ref('')
const noteDrafts = reactive<Record<string, string>>({})
const tagsDrafts = reactive<Record<string, string>>({})
const message = ref('')
const savingWordId = ref<string | null>(null)
const deletingWordId = ref<string | null>(null)

const filteredRows = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  if (!keyword) {
    return rows.value
  }

  return rows.value.filter((row) => row.entry.headwordLower.includes(keyword))
})

async function loadRows() {
  loading.value = true
  try {
    rows.value = await listWordbookItems()
    for (const row of rows.value) {
      noteDrafts[row.item.wordId] = row.item.note
      tagsDrafts[row.item.wordId] = row.item.tags.join(', ')
    }
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void loadRows()
})

function isRowBusy(wordId: string): boolean {
  return savingWordId.value === wordId || deletingWordId.value === wordId
}

async function onSave(row: WordbookWithEntry) {
  const tags = parseJsonArray(JSON.stringify((tagsDrafts[row.item.wordId] ?? '').split(',')))
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)

  savingWordId.value = row.item.wordId
  try {
    await updateWordbookItem(row.item.wordId, {
      note: noteDrafts[row.item.wordId] ?? '',
      tags,
    })

    message.value = `已更新 ${row.entry.headword}`
    await loadRows()
  } finally {
    savingWordId.value = null
  }
}

async function onDelete(wordId: string) {
  const row = rows.value.find((item) => item.item.wordId === wordId)
  if (!window.confirm(`确认删除 ${row?.entry.headword ?? '该单词'} 吗？`)) {
    return
  }

  deletingWordId.value = wordId
  try {
    await removeWordFromWordbook(wordId)
    message.value = '已删除单词'
    await loadRows()
  } finally {
    deletingWordId.value = null
  }
}
</script>

<template>
  <section class="panel">
    <Transition name="soft-fade-slide">
      <p v-if="message" class="success" role="status" aria-live="polite">{{ message }}</p>
    </Transition>

    <input v-model="query" class="search-input" type="text" placeholder="搜索单词本" />

    <Transition name="soft-fade-slide">
      <p v-if="loading" class="muted">加载中...</p>
    </Transition>

    <Transition name="soft-fade-slide">
      <p v-if="!loading && filteredRows.length === 0" class="muted">暂无数据</p>
    </Transition>

    <TransitionGroup v-if="!loading && filteredRows.length > 0" name="soft-list" tag="div" class="entry-list">
      <div v-for="row in filteredRows" :key="row.item.wordId" class="entry-card">
        <div class="entry-header">
          <h3>{{ row.entry.headword }}</h3>
          <span class="chip">周期 {{ row.reviewState?.cycle ?? 0 }}</span>
        </div>

        <ul>
          <li v-for="sense in parseJsonArray(row.entry.sensesJson)" :key="sense">{{ sense }}</li>
        </ul>

        <input
          v-model="noteDrafts[row.item.wordId]"
          class="inline-input"
          type="text"
          placeholder="备注"
          :disabled="isRowBusy(row.item.wordId)"
        />
        <input
          v-model="tagsDrafts[row.item.wordId]"
          class="inline-input"
          type="text"
          placeholder="标签，逗号分隔"
          :disabled="isRowBusy(row.item.wordId)"
        />

        <div class="actions">
          <button class="btn" :disabled="isRowBusy(row.item.wordId)" @click="onSave(row)">
            {{ savingWordId === row.item.wordId ? '保存中...' : '保存' }}
          </button>
          <button class="btn btn-danger" :disabled="isRowBusy(row.item.wordId)" @click="onDelete(row.item.wordId)">
            {{ deletingWordId === row.item.wordId ? '删除中...' : '删除' }}
          </button>
        </div>
      </div>
    </TransitionGroup>
  </section>
</template>
