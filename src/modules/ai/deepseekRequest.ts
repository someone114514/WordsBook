/**
 * DeepSeek's current API maps a product-level "medium" preference to high.
 * Keeping that translation in one place prevents individual AI flows from
 * accidentally falling back to non-thinking requests.
 */
export const DEEPSEEK_THINKING = {
  thinking: { type: 'enabled' as const },
  reasoning_effort: 'high' as const,
}

type ChatMessage = { role: 'system' | 'user'; content: string }

export function createDeepseekRequest(options: {
  model: string
  messages: ChatMessage[]
  stream?: boolean
  responseFormat?: boolean
  maxTokens?: number
  thinking?: boolean
}): Record<string, unknown> {
  const thinking = options.thinking ?? true
  return {
    model: options.model,
    messages: options.messages,
    stream: options.stream ?? false,
    ...(options.responseFormat ? { response_format: { type: 'json_object' } } : {}),
    ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
    ...(thinking ? DEEPSEEK_THINKING : { thinking: { type: 'disabled' as const } }),
  }
}
