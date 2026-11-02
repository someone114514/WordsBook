<script setup lang="ts">
import { t } from '../i18n'
import { onMounted, ref } from 'vue'
import { ChevronLeft } from 'lucide-vue-next'
import { useRoute, useRouter } from 'vue-router'
import { contextualBack } from '../app/appNavigation'
import type { ReadingSession } from '../types/models'
import { listReadingHistory, parseReadingSession } from '../modules/reading/readingService'

const sessions = ref<ReadingSession[]>([])
const route = useRoute()
const router = useRouter()
const expandedId = ref('')

function articleText(session: ReadingSession): string {
  try { return parseReadingSession(session).segments.map((segment) => segment.text).join('') }
  catch { return '' }
}

function statusLabel(session: ReadingSession): string {
  if (session.status === 'completed') return t("已完成")
  if (session.status === 'ready') return t("可继续")
  if (session.status === 'failed' && articleText(session)) return t("正文已保留")
  if (session.status === 'failed') return t("生成失败")
  return t("生成中")
}

onMounted(async () => { sessions.value = (await listReadingHistory()).filter((session) => Boolean(articleText(session))) })
</script>

<template>
  <main class="page-shell reading-history-page">
    <header class="detail-header"><button class="btn" type="button" @click="contextualBack(router, route)"><ChevronLeft :size="19" aria-hidden="true" />{{ t("返回学习") }}</button><div><h1>{{ t("文章记录") }}</h1><p>{{ t("保留已经生成的正文、题目进度和翻译") }}</p></div></header>
    <section v-if="sessions.length" class="reading-history-list">
      <article v-for="item in sessions" :key="item.sessionId" class="panel reading-history-card">
        <div class="reading-history-heading"><div><strong>{{ item.title || t("语境文章") }}</strong><p>{{ t("{0} · {1} 个目标词 · {2}", [item.dayKey, item.targetWordIds.length, statusLabel(item)]) }}</p></div><div class="actions"><RouterLink class="btn btn-primary" :to="{ path: '/review/reading', query: { session: `daily:${item.dayKey}`, batch: item.batchIndex, history: '1' } }">{{ t("继续阅读") }}</RouterLink><RouterLink class="btn" :to="{ path: '/review/reading', query: { session: `daily:${item.dayKey}`, batch: item.batchIndex, history: '1', restart: '1' } }">{{ t("重做题目") }}</RouterLink><button class="btn" type="button" :aria-expanded="expandedId === item.sessionId" @click="expandedId = expandedId === item.sessionId ? '' : item.sessionId">{{ expandedId === item.sessionId ? t("收起") : t("查看") }}</button></div></div>
        <div v-if="expandedId === item.sessionId" class="reading-history-copy"><p>{{ articleText(item) }}</p><details v-if="item.translation"><summary>{{ t("全文翻译") }}</summary><p>{{ item.translation }}</p></details></div>
      </article>
    </section>
    <section v-else class="panel empty-state"><h2>{{ t("还没有文章记录") }}</h2><p>{{ t("完成卡片学习后，可以生成包含当天单词的语境文章。") }}</p><RouterLink class="btn btn-primary" to="/review">{{ t("返回学习") }}</RouterLink></section>
  </main>
</template>
