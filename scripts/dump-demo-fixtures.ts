// Records demo/fixtures/<number>.json from a database where the jury demo invoices were investigated by the
// pipeline (mock provider): what seedJuryDemo() replays without calling a model.
//
//   DATABASE_PATH=/tmp/jury/payroll.sqlite bun scripts/dump-demo-fixtures.ts [tenant]
//
// Without a tenant the newest row per invoice number across all tenants is used.
import { Database } from 'bun:sqlite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const NUMBERS = ['INV-0401', 'INV-0412', 'INV-0423', 'INV-0388', 'INV-0432']

interface Row {
  tenant_id: string
  number: string
  file_path: string | null
  status: string
  score: number | null
  decision_text: string | null
  issue_date: string | null
  due_date: string | null
  currency: string | null
  amount: number | null
  amount_eur: number | null
  fx_rate: number | null
  fx_source: string | null
  fx_at: string | null
  payee_name: string | null
  payee_wallet: string | null
  extracted_json: string | null
  checklist_json: string | null
}

const dbPath = resolve(process.env.DATABASE_PATH ?? './data/payroll.sqlite')
const tenant = process.argv[2] ?? null
const db = new Database(dbPath, { readonly: true })
const payees = JSON.parse(await Bun.file(resolve('demo/payees.json')).text()) as { invoices: { file: string; number: string; payee_id: string }[] }
const outDir = resolve('demo/fixtures')
mkdirSync(outDir, { recursive: true })

for (const number of NUMBERS) {
  const row = (
    tenant
      ? db.query('SELECT * FROM invoices WHERE number = ? AND tenant_id = ? ORDER BY created_at DESC LIMIT 1').get(number, tenant)
      : db.query('SELECT * FROM invoices WHERE number = ? ORDER BY created_at DESC LIMIT 1').get(number)
  ) as Row | null
  if (!row || !row.checklist_json || !row.extracted_json) {
    console.error(`${number}: no investigated row found`)
    continue
  }
  const entry = payees.invoices.find((i) => i.number === number)
  if (!entry) {
    console.error(`${number}: not in demo/payees.json`)
    continue
  }
  const checklist = JSON.parse(row.checklist_json) as { entries: { status: string }[]; finished_at: string | null }
  if (!checklist.finished_at) {
    console.error(`${number}: investigation not finished (status ${row.status})`)
    continue
  }
  const fixture = {
    number,
    file: entry.file.split('/').pop(),
    payee_id: entry.payee_id,
    status: row.status,
    score: row.score,
    decision_text: row.decision_text,
    invoice: {
      issue_date: row.issue_date,
      due_date: row.due_date,
      currency: row.currency,
      amount: row.amount,
      amount_eur: row.amount_eur,
      fx_rate: row.fx_rate,
      fx_source: row.fx_source,
      fx_at: row.fx_at,
      payee_name: row.payee_name,
      payee_wallet: row.payee_wallet,
    },
    extracted: JSON.parse(row.extracted_json) as unknown,
    checklist: JSON.parse(row.checklist_json) as unknown,
  }
  writeFileSync(resolve(outDir, `${number}.json`), `${JSON.stringify(fixture, null, 2)}\n`)
  const statuses = checklist.entries.reduce<Record<string, number>>((acc, e) => ({ ...acc, [e.status]: (acc[e.status] ?? 0) + 1 }), {})
  console.log(`${number}: ${row.status} score ${row.score} · ${JSON.stringify(statuses)} · ${row.currency} ${row.amount} → €${row.amount_eur}`)
}
