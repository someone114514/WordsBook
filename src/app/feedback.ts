import { readonly, ref } from 'vue'

export type AppToastTone = 'info' | 'success' | 'error'

export interface AppToast {
  id: number
  message: string
  tone: AppToastTone
  duration: number
}

const activeToast = ref<AppToast | null>(null)
let nextToastId = 0
let dismissTimer = 0

export function notify(
  message: string,
  options: { tone?: AppToastTone; duration?: number } = {},
): number {
  const id = ++nextToastId
  const duration = options.duration ?? (options.tone === 'error' ? 5_000 : 3_200)
  window.clearTimeout(dismissTimer)
  activeToast.value = {
    id,
    message,
    tone: options.tone ?? 'info',
    duration,
  }
  if (duration > 0) {
    dismissTimer = window.setTimeout(() => dismissToast(id), duration)
  }
  return id
}

export function dismissToast(id?: number): void {
  if (id !== undefined && activeToast.value?.id !== id) return
  window.clearTimeout(dismissTimer)
  activeToast.value = null
}

export function useAppFeedback() {
  return {
    toast: readonly(activeToast),
    dismissToast,
  }
}
