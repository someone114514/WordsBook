<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ChevronLeft } from 'lucide-vue-next'
import type { ReadingSession } from '../types/models'
import { listReadingHistory, parseReadingSession } from '../modules/reading/readingService'

const sessions = ref<ReadingSession[]>([])
const expandedId = ref('')

function articleText(session: ReadingSession): string {
  try { return parseReadingSession(session).segments.map((segment) => segment.text).join('') }
  catch { return '' }
}

function statusLabel(session: ReadingSession): string {
  if (session.status === 'completed') return '已完成'
  if (session.status === 'ready') return '可继续'
  if (session.status === 'failed' && articleText(session)) return '正文已保留'
  if (session.status === 'failed') return '生成失败'
  return '生成中'
}

onMounted(async () => { sessions.value = (await listReadingHistory()).filter((session) => Boolean(articleText(session))) })
</script>

<template>
  <main class="page-shell reading-history-page">
    <header class="detail-header"><RouterLink class="btn" to="/review"><ChevronLeft :size="19" aria-hidden="true" />返回学习</RouterLink><div><h1>文章记录</h1><p>保留已经生成的正文、题目进度和翻译</p></div></header>
    <section v-if="sessions.length" class="reading-history-list">
      <article v-for="item in sessions" :key="item.sessionId" class="panel reading-history-card">
        <div class="reading-history-heading"><div><strong>{{ item.title || '语境文章' }}</strong><p>{{ item.dayKey }} · {{ item.targetWordIds.length }} 个目标词 · {{ statusLabel(item) }}</p></div><div class="actions"><RouterLink class="btn btn-primary" :to="{ path: '/review/reading', query: { session: `daily:${item.dayKey}`, batch: item.batchIndex, history: '1' } }">继续阅读</RouterLink><RouterLink class="btn" :to="{ path: '/review/reading', query: { session: `daily:${item.dayKey}`, batch: item.batchIndex, history: '1', restart: '1' } }">重做题目</RouterLink><button class="btn" type="button" :aria-expanded="expandedId === item.sessionId" @click="expandedId = expandedId === item.sessionId ? '' : item.sessionId">{{ expandedId === item.sessionId ? '收起' : '查看' }}</button></div></div>
        <div v-if="expandedId === item.sessionId" class="reading-history-copy"><p>{{ articleText(item) }}</p><details v-if="item.translation"><summary>全文翻译</summary><p>{{ item.translation }}</p></details></div>
      </article>
    </section>
    <section v-else class="panel empty-state"><h2>还没有文章记录</h2><p>完成卡片学习后，可以生成包含当天单词的语境文章。</p><RouterLink class="btn btn-primary" to="/review">返回学习</RouterLink></section>
  </main>
</template>
