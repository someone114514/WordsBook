<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { t } from '../i18n'
import { dismissTutorial, tutorialOpen, tutorialStep } from '../app/onboarding'

const router = useRouter()
const steps = computed(() => [
  {
    title: t('从查一个词开始'),
    body: t('输入英文单词，查看释义、例句并播放发音。首次使用会准备核心词典，下载后可离线查词。'),
    hint: t('试试 resilient：输入后按回车即可查询。'),
    action: t('试着查一个词'),
    route: '/lookup?q=resilient',
  },
  {
    title: t('把想学的词加入词表'),
    body: t('在查词结果中选择“加入学习”，将单词加入学习词表。也可以在词表页新建词表或批量导入。'),
    hint: t('“仅保存”的词留作参考；加入学习词表的词才会进入每日学习。'),
    action: t('打开词表'),
    route: '/lists',
  },
  {
    title: t('每天回忆，再看答案'),
    body: t('在学习页开始今日学习，先回想释义，再显示答案并如实评分。系统会安排后续复习。'),
    hint: t('设置中可切换语言和调整每日目标。填写 DeepSeek API Key 后，还可使用 AI 释义与语境文章。'),
    action: t('打开今日学习'),
    route: '/review',
  },
])
const step = computed(() => steps.value[tutorialStep.value]!)
</script>

<template>
  <section v-if="tutorialOpen" class="getting-started" aria-labelledby="tutorial-title">
    <div class="tutorial-heading">
      <h2 id="tutorial-title">{{ t('新手教程') }}</h2>
      <button class="btn btn-quiet" type="button" @click="dismissTutorial">{{ t('跳过教程') }}</button>
    </div>
    <div aria-live="polite" aria-atomic="true">
      <p class="muted">{{ t('第 {0} 步，共 {1} 步', [tutorialStep + 1, steps.length]) }}</p>
      <h3>{{ step.title }}</h3>
      <p>{{ step.body }}</p>
      <p class="muted">{{ step.hint }}</p>
    </div>
    <div class="tutorial-actions">
      <button class="btn" type="button" @click="router.push(step.route)">{{ step.action }}</button>
      <button v-if="tutorialStep > 0" class="btn btn-quiet" type="button" @click="tutorialStep--">{{ t('上一步') }}</button>
      <button v-if="tutorialStep < steps.length - 1" class="btn btn-primary" type="button" @click="tutorialStep++">{{ t('下一步') }}</button>
      <button v-else class="btn btn-primary" type="button" @click="dismissTutorial">{{ t('完成教程') }}</button>
    </div>
  </section>
</template>

<style scoped>
.getting-started { margin: 0 0 24px; padding: 20px; border: 1px solid var(--border, #d1d1d6); border-radius: 14px; }
.tutorial-heading, .tutorial-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.tutorial-heading { justify-content: space-between; }
.tutorial-heading h2 { margin: 0; }
.getting-started h3 { margin: 16px 0 8px; }
.getting-started p { max-width: 68ch; line-height: 1.6; }
.tutorial-actions { margin-top: 20px; }
.tutorial-actions .btn { white-space: normal; }
</style>
