// EURC issuer check: ESMA EMT register row + latest reserve attestation vs live on-chain supply.
// Two ratios are reported: the attested ratio (reserves / circulation, both at the report date)
// decides pass/fail; live supply vs attested circulation measures how stale the attestation is.
import issuers from '../../../../config/issuers.json'
import { agentEnv } from '../env'
import { type CheckContext, type CheckSpec, makeResult } from './context'

const spec = { id: 'issuer_backing', label: 'Issuer backing (MiCA EMT)', enforcement: 'agent', weight: 5 } as const

type SupplySource = {
  chain: string
  kind: 'evm' | 'solana'
  contract?: string
  mint?: string
  decimals: number
  tatum_gateway: string
  public_rpc: string
}

interface SupplyReading {
  chain: string
  supply: number | null
  rpc: 'tatum' | 'public' | 'none'
  error?: string
}

const rpcCall = async (url: string, method: string, params: unknown[], apiKey?: string): Promise<unknown> => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(apiKey ? { 'x-api-key': apiKey } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } }
  if (body.error) throw new Error(body.error.message ?? 'rpc error')
  return body.result
}

const readSupply = async (src: SupplySource, url: string, apiKey?: string): Promise<number> => {
  if (src.kind === 'evm') {
    const hex = (await rpcCall(url, 'eth_call', [{ to: src.contract, data: '0x18160ddd' }, 'latest'], apiKey)) as string
    return Number(BigInt(hex)) / 10 ** src.decimals
  }
  const result = (await rpcCall(url, 'getTokenSupply', [src.mint], apiKey)) as { value?: { amount?: string; decimals?: number } }
  const amount = result.value?.amount
  if (!amount) throw new Error('no supply in response')
  return Number(BigInt(amount)) / 10 ** (result.value?.decimals ?? src.decimals)
}

const readAll = async (sources: SupplySource[]): Promise<SupplyReading[]> => {
  const key = agentEnv.tatumApiKey()
  return Promise.all(
    sources.map(async (src): Promise<SupplyReading> => {
      if (agentEnv.offline()) return { chain: src.chain, supply: null, rpc: 'none', error: 'offline' }
      if (key) {
        try {
          return { chain: src.chain, supply: await readSupply(src, src.tatum_gateway, key), rpc: 'tatum' }
        } catch {
          // fall back to the public RPC
        }
      }
      try {
        return { chain: src.chain, supply: await readSupply(src, src.public_rpc), rpc: 'public' }
      } catch (error) {
        return { chain: src.chain, supply: null, rpc: 'none', error: error instanceof Error ? error.message : String(error) }
      }
    }),
  )
}

const fmtEur = (n: number): string => `€${(n / 1e6).toFixed(1)}m`

export const run = async (ctx: CheckContext) => {
  const token = issuers.tokens.EURC
  const issuer = issuers.issuers[token.issuer_lei as keyof typeof issuers.issuers]
  const att = token.attestation
  const readings = await readAll(token.supply_sources as SupplySource[])
  const read = readings.filter((r) => r.supply !== null)
  const liveSupply = read.length ? read.reduce((s, r) => s + (r.supply ?? 0), 0) : null
  const authority = issuer.competent_authority.split('(')[1]?.replace(')', '') ?? issuer.competent_authority
  const registerNote = `${issuer.legal_name} (LEI ${issuer.lei}) is in the ESMA EMT register: ${issuer.authorisation_type}, ${authority} ${issuer.home_member_state}, authorised ${issuer.authorisation_date}, EURC DTI ${token.dti_ffg}`
  const supplyNote = liveSupply !== null
    ? `live supply ${fmtEur(liveSupply)} (${read.map((r) => `${r.chain} ${fmtEur(r.supply ?? 0)}`).join(', ')}${read.length < readings.length ? `; ${readings.length - read.length} chain(s) unreadable` : ''})`
    : 'live supply unreadable'
  const rpcKind = read.some((r) => r.rpc === 'tatum') ? 'Tatum RPC gateway' : 'public RPC'
  const source = `${issuer.register} (row updated ${issuer.register_row_last_update}); ${att.source_note ?? 'reserve attestation'} (${att.source_url}); token supply via ${rpcKind} at ${ctx.now.toISOString()}`
  const base = { issuer: issuer.lei, dti: token.dti_ffg, readings, live_supply: liveSupply, testnet_note: token.testnet_note }

  if (att.reserves_eur === null || att.circulation_eur_at_report === null || !att.report_date) {
    return makeResult(spec, ctx, {
      status: 'warn',
      evidence: `${registerNote}. Reserve attestation figures are not configured (config/issuers.json), so the backing ratio cannot be computed; ${supplyNote}.`,
      source,
      data: { ...base, attested_ratio: null, attestation: null },
    })
  }
  const reserves = att.reserves_eur as number
  const circulation = att.circulation_eur_at_report as number
  const ageDays = Math.floor((ctx.now.getTime() - new Date(att.report_date).getTime()) / 86_400_000)
  const attestedRatio = reserves / circulation
  const drift = liveSupply !== null ? liveSupply / circulation - 1 : null
  const liveCoverage = liveSupply !== null ? reserves / liveSupply : null
  const attestation = { reserves, circulation, report_date: att.report_date, age_days: ageDays, max_age_days: att.max_age_days }
  const data = { ...base, attested_ratio: attestedRatio, live_coverage: liveCoverage, supply_drift: drift, attestation }
  const ratioNote = `attested ${fmtEur(reserves)} reserves vs ${fmtEur(circulation)} in circulation at ${att.report_date} = ${attestedRatio.toFixed(3)} (${ageDays} days old)`

  if (attestedRatio < 1) {
    return makeResult(spec, ctx, { status: 'fail', evidence: `${registerNote}. Backing below 1:1: ${ratioNote}. Payouts paused.`, source, data })
  }
  const reasons: string[] = []
  if (ageDays > att.max_age_days) reasons.push(`attestation older than ${att.max_age_days} days`)
  if (liveSupply === null) reasons.push('live supply unreadable')
  else if (read.length < readings.length) reasons.push('partial supply read')
  if (drift !== null && drift > att.max_supply_drift) reasons.push(`supply grew ${(drift * 100).toFixed(0)}% since the report`)
  const driftNote = drift !== null ? `; ${supplyNote}, ${drift >= 0 ? '+' : ''}${(drift * 100).toFixed(1)}% vs attested circulation` : `; ${supplyNote}`
  if (reasons.length) {
    return makeResult(spec, ctx, {
      status: 'warn',
      evidence: `${registerNote}. ${ratioNote}${driftNote}. Inputs stale or partial (${reasons.join(', ')}); owner review.`,
      source,
      data,
    })
  }
  return makeResult(spec, ctx, { status: 'pass', evidence: `${registerNote}. Fully backed: ${ratioNote}${driftNote}.`, source, data })
}

export const issuerBacking: CheckSpec = { ...spec, run }
