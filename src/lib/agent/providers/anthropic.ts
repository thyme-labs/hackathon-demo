// Anthropic Messages API provider (fallback when Bedrock is not reachable from Railway).
import Anthropic from '@anthropic-ai/sdk'
import { agentEnv } from '../env'
import { costUsd } from './pricing'
import type { ConverseRequest, ConverseResult, LlmContent, LlmMessage, LlmProvider, ToolCall } from './types'

const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')

const toAnthropicContent = (block: LlmContent): Anthropic.ContentBlockParam => {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'document':
      return {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: toBase64(block.bytes) },
      }
    case 'image':
      return {
        type: 'image',
        source: { type: 'base64', media_type: block.format === 'png' ? 'image/png' : 'image/jpeg', data: toBase64(block.bytes) },
      }
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input }
    case 'tool_result':
      return { type: 'tool_result', tool_use_id: block.toolUseId, content: block.content, is_error: block.isError }
  }
}

const toAnthropicMessage = (message: LlmMessage): Anthropic.MessageParam => ({
  role: message.role,
  content: message.content.map(toAnthropicContent),
})

const toAnthropicToolChoice = (choice: ConverseRequest['toolChoice']): Anthropic.ToolChoice | undefined => {
  if (!choice) return undefined
  if (choice.type === 'auto') return { type: 'auto' }
  if (choice.type === 'any') return { type: 'any' }
  return { type: 'tool', name: choice.name }
}

export const createAnthropicProvider = (client?: Anthropic): LlmProvider => {
  const anthropic = client ?? new Anthropic({ apiKey: agentEnv.anthropicApiKey() })
  return {
    name: 'anthropic',
    async converse(request: ConverseRequest): Promise<ConverseResult> {
      const modelId =
        request.model === 'extract' ? agentEnv.anthropicModelExtract() : agentEnv.anthropicModelReason()
      const tools: Anthropic.Tool[] | undefined = request.tools?.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      }))
      const started = Date.now()
      const res = await anthropic.messages.create({
        model: modelId,
        max_tokens: request.maxTokens ?? 2048,
        temperature: request.temperature ?? 0,
        system: request.system,
        messages: request.messages.map(toAnthropicMessage),
        ...(tools && tools.length > 0 ? { tools, tool_choice: toAnthropicToolChoice(request.toolChoice) } : {}),
      })
      const toolCalls: ToolCall[] = []
      let text = ''
      for (const block of res.content) {
        if (block.type === 'tool_use') {
          toolCalls.push({ id: block.id, name: block.name, input: (block.input ?? {}) as Record<string, unknown> })
        } else if (block.type === 'text') {
          text += block.text
        }
      }
      const usage = {
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
        cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
      }
      return {
        toolCalls,
        text,
        usage,
        modelId,
        costUsd: costUsd(modelId, usage),
        latencyMs: Date.now() - started,
        stopReason: res.stop_reason ?? 'unknown',
      }
    },
  }
}
