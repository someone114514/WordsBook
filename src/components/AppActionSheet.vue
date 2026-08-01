<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { X } from 'lucide-vue-next'

const props = withDefaults(defineProps<{
  open: boolean
  title?: string
  ariaLabel?: string
  dismissible?: boolean
}>(), {
  title: '',
  ariaLabel: '',
  dismissible: true,
})

const emit = defineEmits<{
  close: []
}>()

const panel = ref<HTMLElement | null>(null)
let previousFocus: HTMLElement | null = null
let previousOverflow = ''

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function close(): void {
  if (props.dismissible) emit('close')
}

function onKeydown(event: KeyboardEvent): void {
  if (!props.open) return
  if (event.key === 'Escape') {
    event.preventDefault()
    close()
    return
  }
  if (event.key !== 'Tab' || !panel.value) return

  const focusable = [...panel.value.querySelectorAll<HTMLElement>(focusableSelector)]
  if (!focusable.length) {
    event.preventDefault()
    panel.value.focus()
    return
  }

  const first = focusable[0]!
  const last = focusable[focusable.length - 1]!
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

watch(() => props.open, async (open) => {
  if (open) {
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', onKeydown)
    await nextTick()
    const first = panel.value?.querySelector<HTMLElement>(focusableSelector)
    ;(first ?? panel.value)?.focus()
  } else {
    document.body.style.overflow = previousOverflow
    document.removeEventListener('keydown', onKeydown)
    previousFocus?.focus()
    previousFocus = null
  }
}, { immediate: true })

onBeforeUnmount(() => {
  document.body.style.overflow = previousOverflow
  document.removeEventListener('keydown', onKeydown)
  previousFocus?.focus()
})
</script>

<template>
  <Teleport to="body">
    <Transition name="sheet-rise">
      <div v-if="open" class="sheet-backdrop app-action-sheet-backdrop" @mousedown.self="close">
        <section
          ref="panel"
          class="bottom-action-sheet app-action-sheet"
          role="dialog"
          aria-modal="true"
          :aria-label="ariaLabel || title"
          tabindex="-1"
        >
          <header v-if="title || $slots.header" class="app-action-sheet-header">
            <slot name="header">
              <h2>{{ title }}</h2>
            </slot>
            <button v-if="dismissible" class="app-icon-button" type="button" aria-label="关闭" @click="close">
              <X :size="20" aria-hidden="true" />
            </button>
          </header>
          <div class="app-action-sheet-content">
            <slot />
          </div>
          <footer v-if="$slots.actions" class="app-action-sheet-actions">
            <slot name="actions" />
          </footer>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>
