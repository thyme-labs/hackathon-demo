// Per-million-token list prices used for the cost artefact shown in the UI.
// Anthropic first-party list prices; Bedrock EU inference pricing is the same
// order of magnitude (check the AWS pricing page for the exact regional figure).

export interface ModelPrice {
  family: string
  inputPerM: number
  outputPerM: number
  cacheReadPerM: number
  cacheWritePerM: number
}

const PRICES: { match: RegExp; price: ModelPrice }[] = [
  {
    match: /haiku-4-5/i,
    price: { family: 'Claude Haiku 4.5', inputPerM: 1, outputPerM: 5, cacheReadPerM: 0.1, cacheWritePerM: 1.25 },
  },
  {
    match: /sonnet-4-5/i,
    price: { family: 'Claude Sonnet 4.5', inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 3.75 },
  },
]

export const priceForModel = (modelId: string): ModelPrice | null =>
  PRICES.find((p) => p.match.test(modelId))?.price ?? null

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export const costUsd = (modelId: string, usage: TokenUsage): number => {
  const price = priceForModel(modelId)
  if (!price) return 0
  const cost =
    (usage.inputTokens * price.inputPerM +
      usage.outputTokens * price.outputPerM +
      usage.cacheReadTokens * price.cacheReadPerM +
      usage.cacheWriteTokens * price.cacheWritePerM) /
    1_000_000
  return Math.round(cost * 1e6) / 1e6
}
