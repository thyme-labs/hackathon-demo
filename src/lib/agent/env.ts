// Central reader for the environment variables the agent uses. Names only; values
// come from Railway variables or .env and are never committed.

const read = (name: string): string | undefined => {
  const value = process.env[name]
  return value === undefined || value === '' ? undefined : value
}

export type LlmProviderName = 'bedrock' | 'anthropic' | 'mock'

export const agentEnv = {
  llmProvider(): LlmProviderName {
    const raw = (read('LLM_PROVIDER') ?? 'mock').toLowerCase()
    if (raw === 'bedrock' || raw === 'anthropic' || raw === 'mock') return raw
    return 'mock'
  },
  awsRegion: () => read('AWS_REGION') ?? 'eu-central-1',
  bedrockModelExtract: () =>
    read('BEDROCK_MODEL_EXTRACT') ?? 'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
  bedrockModelReason: () =>
    read('BEDROCK_MODEL_REASON') ?? 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0',
  anthropicApiKey: () => read('ANTHROPIC_API_KEY'),
  anthropicModelExtract: () => read('ANTHROPIC_MODEL_EXTRACT') ?? 'claude-haiku-4-5',
  anthropicModelReason: () => read('ANTHROPIC_MODEL_REASON') ?? 'claude-sonnet-4-5',
  tatumApiKey: () => read('TATUM_API_KEY'),
  apifyToken: () => read('APIFY_TOKEN'),
  mostlyRightApiKey: () => read('MOSTLYRIGHT_API_KEY'),
  paymentExecutor: (): 'thyme' | 'direct' => (read('PAYMENT_EXECUTOR') === 'thyme' ? 'thyme' : 'direct'),
  autoPayThreshold: (): number => {
    const n = Number(read('AUTO_PAY_THRESHOLD') ?? '100')
    return Number.isFinite(n) ? n : 100
  },
  /** Directory for runtime downloads (sanctions lists). Gitignored. */
  dataDir: () => read('DATA_DIR') ?? 'data',
  /** Set to '1' to skip all outbound HTTP (offline demo). */
  offline: () => read('AGENT_OFFLINE') === '1',
}
