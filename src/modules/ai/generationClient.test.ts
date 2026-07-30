import { afterEach, describe, expect, it, vi } from 'vitest'
import { GenerationRequestError, requestJsonCompletion } from './generationClient'

describe('generation client', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it.each([
    [401, 'unauthorized'],
    [429, 'rate-limited'],
    [500, 'server'],
  ] as const)('classifies HTTP %s without collapsing it into a generic error', async (status, code) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status })))
    await expect(requestJsonCompletion({
      url: 'https://example.test',
      apiKey: 'key',
      body: {},
    })).rejects.toMatchObject({ code })
  })

  it('classifies invalid JSON separately from a contract failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not-json', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))
    await expect(requestJsonCompletion({
      url: 'https://example.test',
      apiKey: 'key',
      body: {},
    })).rejects.toMatchObject({ code: 'invalid-json' })
  })

  it('uses the end-to-end deadline instead of treating model thinking as a connection failure', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })))
    const task = requestJsonCompletion({
      url: 'https://example.test',
      apiKey: 'key',
      body: {},
      connectTimeoutMs: 10,
      totalTimeoutMs: 20,
    })
    const assertion = expect(task).rejects.toEqual(
      expect.objectContaining<Partial<GenerationRequestError>>({ code: 'timeout' }),
    )
    await vi.advanceTimersByTimeAsync(21)
    await assertion
  })

  it('does not send a request when the caller signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(requestJsonCompletion({
      url: 'https://example.test',
      apiKey: 'key',
      body: {},
      signal: controller.signal,
    })).rejects.toMatchObject({ code: 'cancelled' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
