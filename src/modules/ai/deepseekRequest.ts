/**
 * DeepSeek V4 only supports high/max reasoning effort and maps low/medium to
 * high. Vocabulary learning requests need short, contract-shaped answers, so
 * they use the fast non-thinking mode by default. Callers must explicitly opt
 * into high reasoning for a task that genuinely benefits from it.
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
  const thinking = options.thinking ?? false
  return {
    model: options.model,
    messages: options.messages,
    stream: options.stream ?? false,
    ...(options.responseFormat ? { response_format: { type: 'json_object' } } : {}),
    ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
    ...(thinking ? DEEPSEEK_THINKING : { thinking: { type: 'disabled' as const } }),
  }
}
