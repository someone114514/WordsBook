export function debounce<T extends (...args: never[]) => void>(fn: T, wait = 250): T {
  let timer: number | undefined

  return ((...args: Parameters<T>) => {
    window.clearTimeout(timer)
    timer = window.setTimeout(() => fn(...args), wait)
  }) as T
}
