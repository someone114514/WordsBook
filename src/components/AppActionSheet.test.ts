import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import AppActionSheet from './AppActionSheet.vue'

afterEach(() => {
  document.body.innerHTML = ''
  document.body.style.overflow = ''
})

describe('AppActionSheet', () => {
  it('locks page scroll, focuses the first action, and closes with Escape', async () => {
    const wrapper = mount(AppActionSheet, {
      attachTo: document.body,
      props: { open: true, title: '单词操作' },
      slots: { default: '<button type="button">确认</button>' },
    })

    await wrapper.vm.$nextTick()
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')
    const firstButton = dialog?.querySelector<HTMLButtonElement>('button')
    expect(dialog?.getAttribute('aria-label')).toBe('单词操作')
    expect(document.body.style.overflow).toBe('hidden')
    expect(document.activeElement).toBe(firstButton)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(wrapper.emitted('close')).toHaveLength(1)
    wrapper.unmount()
  })

  it('does not dismiss a required sheet', async () => {
    const wrapper = mount(AppActionSheet, {
      attachTo: document.body,
      props: { open: true, ariaLabel: '讲解', dismissible: false },
      slots: { default: '<button type="button">继续</button>' },
    })
    await wrapper.vm.$nextTick()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(wrapper.emitted('close')).toBeUndefined()
    wrapper.unmount()
  })
})
