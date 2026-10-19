import { fetchCnbRate, resolveEurRate } from '../fx'
import { type CheckContext, type CheckSpec, eur, makeResult } from './context'

const spec = { id: 'fx_rate', label: 'FX rate', enforcement: 'agent', weight: 5 } as const

/**
 * Stablecoin and crypto tickers an invoice may be denominated in. They are not fiat: no ECB/CNB reference
 * rate, no VAT base, and a rate provider that happens to quote them (Tatum does) must not turn a USDT
 * invoice into an EURC payout. Anything that is not a three-letter ISO 4217 code is refused as well.
 */
const NON_FIAT_TICKERS = new Set([
  'USDT', 'USDC', 'EURC', 'EURT', 'EURS', 'EUROC', 'EURE', 'AGEUR', 'DAI', 'PYUSD', 'USDE', 'FDUSD', 'TUSD', 'BUSD', 'USDP', 'GUSD',
  'BTC', 'XBT', 'WBTC', 'ETH', 'WETH', 'BNB', 'SOL', 'XRP', 'TRX', 'POL', 'MATIC', 'AVAX', 'LTC', 'DOGE', 'ADA', 'DOT',
])

export const isFiatCode = (code: string): boolean => /^[A-Z]{3}$/.test(code) && !NON_FIAT_TICKERS.has(code)

export const run = async (ctx: CheckContext) => {
  const inv = ctx.extracted.invoice
  const currency = inv.currency
  if (!isFiatCode(currency)) {
    const why = NON_FIAT_TICKERS.has(currency) ? 'a stablecoin/crypto ticker' : `a ${currency.length}-letter code`
    return makeResult(spec, ctx, {
      status: 'fail',
      evidence: `Invoice is denominated in ${currency}, ${why}, not a fiat ISO 4217 currency. No EUR reference rate exists for it, so the EURC amount and the CZK accounting leg cannot be derived; ask for an invoice in a fiat currency (EUR, USD, GBP, ...).`,
      source: 'ISO 4217 code check (before Tatum / Frankfurter / static table)',
      data: { currency, unsupported: true },
    })
  }
  const [fx, cnb] = await Promise.all([resolveEurRate(currency), fetchCnbRate('EUR', ctx.now.toISOString().slice(0, 10))])
  ctx.out.cnb = cnb
  const cnbNote = cnb
    ? `CNB 1 EUR = ${cnb.czkPerUnit.toFixed(3)} CZK valid for ${cnb.validFor}${cnb.validFor < cnb.requestedDate ? ' (preceding business day, Accounting Act §24d(3))' : ''}`
    : 'CNB rate unavailable'
  if (!fx) {
    return makeResult(spec, ctx, {
      status: 'fail',
      evidence: `No EUR rate available for ${currency} (Tatum, Frankfurter and the static table all failed). ${cnbNote}.`,
      source: 'Tatum rate API; Frankfurter (ECB); config/lists.json static table; CNB daily fixing',
      data: { currency, cnb },
    })
  }
  ctx.out.fx = fx
  const amountEur = Math.round(inv.gross * fx.quote.rateToEur * 100) / 100
  ctx.out.amountEur = amountEur
  const data = { currency, gross: inv.gross, rate: fx.quote.rateToEur, source: fx.quote.source, at: fx.quote.at, tier: fx.tier, amountEur, cnb }
  const source = `${fx.quote.source} @ ${fx.quote.at}; CNB daily fixing${cnb ? ` ${cnb.validFor}` : ''}`
  if (currency === 'EUR') {
    return makeResult(spec, ctx, { status: 'pass', evidence: `Invoice in EUR: ${eur(amountEur)} = ${amountEur.toFixed(2)} EURC. ${cnbNote}.`, source, data })
  }
  if (fx.tier === 'static') {
    return makeResult(spec, ctx, {
      status: 'warn',
      evidence: `${inv.gross} ${currency} converted with a dated static rate ${fx.quote.rateToEur} (${fx.quote.at.slice(0, 10)}): ${eur(amountEur)}. Live sources unreachable; owner review. ${cnbNote}.`,
      source,
      data,
    })
  }
  return makeResult(spec, ctx, {
    status: 'pass',
    evidence: `${inv.gross} ${currency} x ${fx.quote.rateToEur.toFixed(6)} (${fx.quote.source}, ${fx.quote.at.slice(0, 16)}) = ${eur(amountEur)}. ${cnbNote}.`,
    source,
    data,
  })
}

export const fxRate: CheckSpec = { ...spec, run }
