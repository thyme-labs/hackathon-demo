import { agentEnv } from '../env'
import { createAnthropicProvider } from './anthropic'
import { createBedrockProvider } from './bedrock'
import { createMockProvider } from './mock'
import type { LlmProvider } from './types'

let cached: LlmProvider | null = null

/** Picks the provider from LLM_PROVIDER (bedrock | anthropic | mock). Mock is the default. */
export const getLlmProvider = (): LlmProvider => {
  if (cached) return cached
  const name = agentEnv.llmProvider()
  if (name === 'bedrock') cached = createBedrockProvider()
  else if (name === 'anthropic' && agentEnv.anthropicApiKey()) cached = createAnthropicProvider()
  else cached = createMockProvider()
  return cached
}

/** For tests and for switching providers at runtime from the settings page. */
export const setLlmProvider = (provider: LlmProvider | null): void => {
  cached = provider
}

export type { ConverseRequest, ConverseResult, LlmContent, LlmMessage, LlmProvider, LlmTool, ToolCall } from './types'
export { costUsd, priceForModel } from './pricing'
