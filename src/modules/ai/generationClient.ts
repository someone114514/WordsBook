import type { ReadingErrorCode } from '../../types/models'
import { runWithGenerationLock } from './generationLock'

let generationTail: Promise<unknown> = Promise.resolve()

/** Serializes article and exercise generation in this tab and across tabs. */
export function runSerializedGeneration<T>(task: () => Promise<T>): Promise<T> {
  const run = generationTail
    .catch(() => undefined)
    .then(() => runWithGenerationLock('wordsbook:generation:global', task))
  generationTail = run.then(() => undefined, () => undefined)
  return run
}

export class GenerationRequestError extends Error {
  public readonly code: ReadingErrorCode

  public constructor(message: string, code: ReadingErrorCode) {
    super(message)
    this.name = 'GenerationRequestError'
    this.code = code
  }
}

function statusError(status: number): GenerationRequestError {
  if (status === 401 || status === 403) return new GenerationRequestError('API Key 无效或无权访问模型', 'unauthorized')
  if (status === 402) return new GenerationRequestError('API 余额不足', 'quota')
  if (status === 429) return new GenerationRequestError('请求过于频繁', 'rate-limited')
  if (status >= 500) return new GenerationRequestError('AI 服务暂时不可用', 'server')
  return new GenerationRequestError(`AI 请求失败（HTTP ${status}）`, 'network')
}

type CompletionRequestOptions = {
  url: string
  apiKey: string
  body: Record<string, unknown>
  signal?: AbortSignal
  connectTimeoutMs?: number
  totalTimeoutMs?: number
}

export async function requestTextCompletion(options: CompletionRequestOptions): Promise<string> {
  if (!options.apiKey.trim()) throw new GenerationRequestError('未配置 API Key', 'missing-key')
  if (options.signal?.aborted) throw new GenerationRequestError('请求已取消', 'cancelled')
  const controller = new AbortController()
  let timeoutCode: ReadingErrorCode | undefined
  const abortFromCaller = () => controller.abort()
  options.signal?.addEventListener('abort', abortFromCaller, { once: true })
  // Browser fetch does not expose a distinct "TCP connected" event. A timer
  // around `await fetch()` would therefore be a first-byte timeout and would
  // incorrectly abort healthy non-streaming model requests while they think.
  // Keep connectTimeoutMs in the public options for compatibility, but use the
  // real end-to-end deadline as the enforceable browser timeout.
  const totalTimer = globalThis.setTimeout(() => {
    timeoutCode = 'timeout'
    controller.abort()
  }, options.totalTimeoutMs ?? 45_000)
  try {
    const response = await fetch(options.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${options.apiKey.trim()}`,
      },
      body: JSON.stringify(options.body),
      signal: controller.signal,
    })
    if (!response.ok) throw statusError(response.status)
    let payload: { choices?: Array<{ message?: { content?: string } }> }
    try {
      payload = await response.json() as typeof payload
    } catch {
      throw new GenerationRequestError('AI 返回了无效 JSON', 'invalid-json')
    }
    const content = payload.choices?.[0]?.message?.content?.trim()
    if (!content) throw new GenerationRequestError('AI 返回内容为空', 'contract-invalid')
    return content
  } catch (error) {
    if (timeoutCode) throw new GenerationRequestError('AI 请求超时', timeoutCode)
    if (options.signal?.aborted) throw new GenerationRequestError('请求已取消', 'cancelled')
    if (error instanceof GenerationRequestError) throw error
    if (error instanceof TypeError) throw new GenerationRequestError('无法连接 AI 服务', 'network')
    throw error
  } finally {
    globalThis.clearTimeout(totalTimer)
    options.signal?.removeEventListener('abort', abortFromCaller)
  }
}

export async function requestJsonCompletion(options: CompletionRequestOptions): Promise<unknown> {
  const content = await requestTextCompletion(options)
  try {
    return JSON.parse(content.replace(/^```json\s*/i, '').replace(/```\s*$/i, ''))
  } catch {
    throw new GenerationRequestError('AI 内容不是有效 JSON', 'invalid-json')
  }
}
