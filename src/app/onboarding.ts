import { ref } from 'vue'

const STORAGE_KEY = 'wordsbook:onboarding-completed:v1'
export const tutorialOpen = ref(localStorage.getItem(STORAGE_KEY) !== '1')
export const tutorialStep = ref(0)

export function openTutorial(): void {
  tutorialStep.value = 0
  tutorialOpen.value = true
}

export function dismissTutorial(): void {
  localStorage.setItem(STORAGE_KEY, '1')
  tutorialOpen.value = false
}
