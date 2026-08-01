<script setup lang="ts">
import { CircleCheck, CircleX, Info, X } from 'lucide-vue-next'
import { useAppFeedback } from '../app/feedback'

const { toast, dismissToast } = useAppFeedback()
</script>

<template>
  <Teleport to="body">
    <Transition name="toast-rise">
      <div
        v-if="toast"
        :key="toast.id"
        class="app-toast"
        :class="`app-toast-${toast.tone}`"
        :role="toast.tone === 'error' ? 'alert' : 'status'"
        :aria-live="toast.tone === 'error' ? 'assertive' : 'polite'"
      >
        <CircleCheck v-if="toast.tone === 'success'" :size="20" aria-hidden="true" />
        <CircleX v-else-if="toast.tone === 'error'" :size="20" aria-hidden="true" />
        <Info v-else :size="20" aria-hidden="true" />
        <span>{{ toast.message }}</span>
        <button type="button" aria-label="关闭通知" @click="dismissToast(toast.id)">
          <X :size="18" aria-hidden="true" />
        </button>
      </div>
    </Transition>
  </Teleport>
</template>
