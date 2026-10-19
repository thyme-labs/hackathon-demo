import { loadEuList, loadSdnList } from '../lists'
import { approvedWallets, type CheckContext, type CheckSpec, makeResult, shortAddr } from './context'

const spec = { id: 'sanctions_wallet', label: 'Sanctions: wallet', enforcement: 'agent', weight: 12 } as const

export const run = async (ctx: CheckContext) => {
  // Screen every approved wallet on file (any of them may receive the payout) and the wallet printed on the invoice.
  const seen = new Set<string>()
  const candidates: { role: string; addr: string }[] = []
  for (const w of approvedWallets(ctx)) {
    if (seen.has(w.wallet)) continue
    seen.add(w.wallet)
    candidates.push({ role: w.isPrimary ? 'on file' : `on file${w.label ? ` (${w.label})` : ''}`, addr: w.wallet })
  }
  const printed = ctx.extracted.payment.wallet
  if (printed && !seen.has(printed)) candidates.push({ role: 'printed on invoice', addr: printed })
  const [sdn, eu] = await Promise.all([loadSdnList(), loadEuList()])
  const source = `OFAC SDN ${sdn.fetchedAt.slice(0, 10)} (${sdn.source}, ${sdn.ethIndex.size} ETH addresses); EU consolidated list remarks ${eu.fileGenerationDate || 'n/a'}`
  if (candidates.length === 0) {
    return makeResult(spec, ctx, { status: 'warn', evidence: 'No wallet to screen yet.', source })
  }
  const hits: { role: string; addr: string; list: string; name: string; program: string }[] = []
  for (const c of candidates) {
    const s = sdn.ethIndex.get(c.addr)
    if (s) hits.push({ role: c.role, addr: c.addr, list: 'OFAC SDN', name: s.name, program: s.program })
    for (const subject of eu.subjects) {
      if (subject.ethAddresses.includes(c.addr)) {
        hits.push({ role: c.role, addr: c.addr, list: 'EU consolidated', name: subject.names[0] ?? subject.euReference, program: subject.programme })
      }
    }
  }
  if (hits.length) {
    return makeResult(spec, ctx, {
      status: 'fail',
      evidence: hits
        .map((h) => `Wallet ${h.role} ${h.addr} is listed on ${h.list} as ${h.name} (${h.program}).`)
        .join(' ')
        .concat(' Payment stopped.'),
      source,
      data: { hits },
    })
  }
  return makeResult(spec, ctx, {
    status: 'pass',
    evidence: `${candidates.map((c) => `${shortAddr(c.addr)} (${c.role})`).join(', ')} not on the OFAC SDN digital-currency list or in EU list remarks.`,
    source,
    data: { screened: candidates },
  })
}

export const sanctionsWallet: CheckSpec = { ...spec, run }
