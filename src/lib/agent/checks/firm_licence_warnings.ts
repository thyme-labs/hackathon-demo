// Mostly Right "EU financial firm licences and regulator warnings" (companies only).
import { agentEnv } from '../env'
import { type CheckContext, type CheckSpec, makeResult } from './context'

const spec = { id: 'firm_licence_warnings', label: 'Firm licence & warnings', enforcement: 'agent', weight: 5 } as const

const TABLE_ID = 'b0bc56bb-2e3b-4304-a46d-eb94ceaeed9f'
const QUERY_URL = `https://mostlyright.md/api/v2/public/tables/${TABLE_ID}/query`
const DATASET_URL = 'https://mostlyright.md/datasets/eu-financial-firm-licences-and-regulator-warnings'

interface MrRecord {
  record_id?: string
  record_type?: string
  source_list?: string
  authority?: string
  name?: string
  country?: string
  lei?: string
  website_domain?: string
  category?: string
  detail?: string
  until?: string | null
  source_url?: string
}

type Filter = { column: string; operator: string; value: string }

const COLUMNS = ['record_id', 'record_type', 'source_list', 'authority', 'name', 'country', 'lei', 'website_domain', 'category', 'detail', 'until', 'source_url']

const query = async (key: string, filters: Filter[]): Promise<{ rows: MrRecord[]; version: string | null }> => {
  const res = await fetch(QUERY_URL, {
    method: 'POST',
    headers: { 'x-api-key': key, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ columns: COLUMNS, filters, limit: 50 }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`Mostly Right HTTP ${res.status}`)
  const body = (await res.json()) as { rows?: MrRecord[]; data?: MrRecord[]; version_id?: string; version?: string; table?: { version_id?: string } }
  return { rows: body.rows ?? body.data ?? [], version: body.table?.version_id ?? body.version_id ?? body.version ?? null }
}

const domainOf = (website: string | null | undefined): string | null => {
  if (!website) return null
  try {
    return new URL(website.includes('://') ? website : `https://${website}`).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

export const run = async (ctx: CheckContext) => {
  const b = ctx.beneficiary
  const { type } = ctx.payeeType
  const source = `Mostly Right EU financial firm licences and regulator warnings (${DATASET_URL})`
  const name = b?.name ?? ctx.extracted.payee.name
  if (type !== 'company') {
    return makeResult(spec, ctx, {
      status: 'skip',
      evidence: `Natural person (${ctx.payeeType.source}): the firm dataset carries licences, warnings and EU entity sanctions only.`,
      source,
      data: { payee_type: type, payee_type_source: ctx.payeeType.source },
    })
  }
  // A company that was not looked up is an open item for the owner, not a pass: warn, never skip.
  const key = agentEnv.mostlyRightApiKey()
  if (!key) {
    return makeResult(spec, ctx, {
      status: 'warn',
      evidence: `Dataset not configured: MOSTLYRIGHT_API_KEY is not set, so licences and regulator warnings for "${name}" were not checked. Set the key to run the lookup.`,
      source,
      data: { payee_type: type, payee_type_source: ctx.payeeType.source, configured: false },
    })
  }
  if (agentEnv.offline()) {
    return makeResult(spec, ctx, {
      status: 'warn',
      evidence: `Offline (AGENT_OFFLINE=1): licences and regulator warnings for "${name}" were not checked.`,
      source,
      data: { payee_type: type, payee_type_source: ctx.payeeType.source, configured: true, offline: true },
    })
  }
  const lei = b?.lei ?? ctx.extracted.payee.lei ?? null
  const domain = domainOf(b?.website ?? ctx.extracted.payee.website)
  const filterSets: Filter[][] = []
  if (lei) filterSets.push([{ column: 'lei', operator: 'eq', value: lei }])
  if (domain) filterSets.push([{ column: 'website_domain', operator: 'eq', value: domain }])
  // The query API has no case-insensitive operator; registers mix title case and upper case.
  const nameVariants = Array.from(new Set([name, name.toUpperCase()]))
  for (const variant of nameVariants) filterSets.push([{ column: 'name', operator: 'contains', value: variant }])
  try {
    const rows: MrRecord[] = []
    let version: string | null = null
    for (const filters of filterSets) {
      const r = await query(key, filters)
      version = version ?? r.version
      for (const row of r.rows) if (!rows.some((x) => x.record_id === row.record_id)) rows.push(row)
    }
    const warnings = rows.filter((r) => r.record_type === 'warning' || r.record_type === 'sanction')
    const licences = rows.filter((r) => r.record_type === 'licence')
    const versionNote = version ? `, version ${version}` : ''
    const describe = (r: MrRecord) => `${r.record_type} by ${r.authority ?? r.source_list ?? 'n/a'}: ${r.category ?? ''} ${r.detail ?? ''}`.trim()
    if (warnings.length) {
      return makeResult(spec, ctx, {
        status: 'fail',
        evidence: `${warnings.length} regulator warning/sanction row(s) for "${name}": ${warnings.slice(0, 2).map(describe).join('; ')}.`,
        source: `${source}${versionNote}`,
        data: { rows: warnings.slice(0, 10) },
      })
    }
    if (licences.length) {
      const active = licences.filter((r) => !r.until)
      return makeResult(spec, ctx, {
        status: 'pass',
        evidence: `${licences.length} licence row(s), ${active.length} active: ${licences.slice(0, 2).map(describe).join('; ')}. No warnings.`,
        source: `${source}${versionNote}`,
        data: { rows: licences.slice(0, 10) },
      })
    }
    return makeResult(spec, ctx, {
      status: 'pass',
      evidence: `No warning, sanction or licence rows for "${name}"${lei ? ` / LEI ${lei}` : ''}${domain ? ` / ${domain}` : ''}. Absence is not proof of licensing; a software contractor needs none.`,
      source: `${source}${versionNote}`,
      data: { rows: [] },
    })
  } catch (error) {
    return makeResult(spec, ctx, {
      status: 'warn',
      evidence: `Mostly Right lookup failed: ${error instanceof Error ? error.message : String(error)}.`,
      source,
    })
  }
}

export const firmLicenceWarnings: CheckSpec = { ...spec, run }
