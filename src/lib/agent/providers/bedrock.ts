// Amazon Bedrock Converse API provider (EU inference profiles). Credentials come
// from the default AWS credential chain (SSO cache, env vars, instance role).
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type ConverseCommandInput,
  type Message,
  type Tool,
  type ToolChoice as BedrockToolChoice,
  type ToolUseBlock,
} from '@aws-sdk/client-bedrock-runtime'
import { agentEnv } from '../env'
import { costUsd } from './pricing'
import type { ConverseRequest, ConverseResult, LlmContent, LlmMessage, LlmProvider, ToolCall } from './types'

// The document name is deliberately NOT the upload filename: Bedrock passes the
// name to the model and a filename is itself an injection vector.
const DOCUMENT_NAME = 'invoice'

// The SDK does not re-export @smithy/types DocumentType; derive it from an exported shape.
type DocumentType = NonNullable<ToolUseBlock['input']>

const toBedrockContent = (block: LlmContent): ContentBlock => {
  switch (block.type) {
    case 'text':
      return { text: block.text }
    case 'document':
      return { document: { format: 'pdf', name: DOCUMENT_NAME, source: { bytes: block.bytes } } }
    case 'tool_use':
      return { toolUse: { toolUseId: block.id, name: block.name, input: block.input as DocumentType } }
    case 'tool_result':
      return {
        toolResult: {
          toolUseId: block.toolUseId,
          content: [{ text: block.content }],
          status: block.isError ? 'error' : 'success',
        },
      }
  }
}

const toBedrockMessage = (message: LlmMessage): Message => ({
  role: message.role,
  content: message.content.map(toBedrockContent),
})

const toBedrockToolChoice = (choice: ConverseRequest['toolChoice']): BedrockToolChoice | undefined => {
  if (!choice) return undefined
  if (choice.type === 'auto') return { auto: {} }
  if (choice.type === 'any') return { any: {} }
  return { tool: { name: choice.name } }
}

export const createBedrockProvider = (
  client = new BedrockRuntimeClient({ region: agentEnv.awsRegion() }),
): LlmProvider => ({
  name: 'bedrock',
  async converse(request: ConverseRequest): Promise<ConverseResult> {
    const modelId = request.model === 'extract' ? agentEnv.bedrockModelExtract() : agentEnv.bedrockModelReason()
    const tools: Tool[] | undefined = request.tools?.map((t) => ({
      toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.inputSchema as DocumentType } },
    }))
    const input: ConverseCommandInput = {
      modelId,
      system: [{ text: request.system }],
      messages: request.messages.map(toBedrockMessage),
      inferenceConfig: { maxTokens: request.maxTokens ?? 2048, temperature: request.temperature ?? 0 },
      ...(tools && tools.length > 0
        ? { toolConfig: { tools, toolChoice: toBedrockToolChoice(request.toolChoice) } }
        : {}),
    }
    const started = Date.now()
    const res = await client.send(new ConverseCommand(input))
    const content = res.output?.message?.content ?? []
    const toolCalls: ToolCall[] = content
      .filter((b) => b.toolUse)
      .map((b) => ({
        id: b.toolUse?.toolUseId ?? '',
        name: b.toolUse?.name ?? '',
        input: (b.toolUse?.input ?? {}) as Record<string, unknown>,
      }))
    const text = content.map((b) => b.text ?? '').join('')
    const usage = {
      inputTokens: res.usage?.inputTokens ?? 0,
      outputTokens: res.usage?.outputTokens ?? 0,
      cacheReadTokens: res.usage?.cacheReadInputTokens ?? 0,
      cacheWriteTokens: res.usage?.cacheWriteInputTokens ?? 0,
    }
    return {
      toolCalls,
      text,
      usage,
      modelId,
      costUsd: costUsd(modelId, usage),
      latencyMs: res.metrics?.latencyMs ?? Date.now() - started,
      stopReason: res.stopReason ?? 'unknown',
    }
  },
})
