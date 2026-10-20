import type { TokenUsage } from './pricing'

export type ModelRole = 'extract' | 'reason'

export type ImageFormat = 'png' | 'jpeg'

export type LlmContent =
  | { type: 'text'; text: string }
  | { type: 'document'; format: 'pdf'; bytes: Uint8Array }
  | { type: 'image'; format: ImageFormat; bytes: Uint8Array }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }

export interface LlmMessage {
  role: 'user' | 'assistant'
  content: LlmContent[]
}

export interface LlmTool {
  name: string
  description: string
  /** JSON Schema (draft 2020-12 subset accepted by both Bedrock Converse and the Messages API). */
  inputSchema: Record<string, unknown>
}

export type ToolChoice = { type: 'auto' } | { type: 'any' } | { type: 'tool'; name: string }

export interface ConverseRequest {
  model: ModelRole
  system: string
  messages: LlmMessage[]
  tools?: LlmTool[]
  toolChoice?: ToolChoice
  maxTokens?: number
  temperature?: number
  /**
   * Base name of the attached invoice file. Read by the mock provider only (demo lookup by file name);
   * the Bedrock and Anthropic adapters never forward it, because a file name is itself an injection vector.
   */
  sourceName?: string
}

export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ConverseResult {
  toolCalls: ToolCall[]
  text: string
  usage: TokenUsage
  modelId: string
  costUsd: number
  latencyMs: number
  stopReason: string
}

export interface LlmProvider {
  readonly name: 'bedrock' | 'anthropic' | 'mock'
  converse(request: ConverseRequest): Promise<ConverseResult>
}
