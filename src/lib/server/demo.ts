// Server-only helpers around demo/ (synthetic payees and invoices).
import { copyFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import demoPayees from '../../../demo/payees.json'
import { appendAudit, invoices, newId } from '../store/repos'
import { invoicesDir } from '../store/sqlite'

if (typeof window !== 'undefined') {
  throw new Error('src/lib/server/demo.ts is server-only')
}

interface DemoPayee {
  id: string
  name: string
  wallet: string
  ownership_proof?: Record<string, unknown>
}

const payees = (demoPayees as unknown as { payees: DemoPayee[] }).payees

export function demoInvoicesDir(): string {
  const fromEnv = process.env.DEMO_INVOICES_DIR
  if (fromEnv) return resolve(fromEnv)
  const candidates = [resolve(process.cwd(), 'demo/invoices'), resolve(process.cwd(), '../demo/invoices')]
  return candidates.find((c) => existsSync(c)) ?? candidates[0]
}

/** EIP-712 ownership proof shipped with the demo payees, when the wallet is one of them. */
export function demoOwnershipProofFor(wallet: string): string | null {
  const hit = payees.find((p) => p.wallet.toLowerCase() === wallet.toLowerCase())
  return hit?.ownership_proof ? JSON.stringify(hit.ownership_proof) : null
}

/** Copies demo/invoices/<file> into the invoices dir, inserts a queued invoice and starts the pipeline. */
export async function enqueueDemoFile(file: string): Promise<string> {
  if (!/^[A-Za-z0-9._-]+\.pdf$/.test(file)) throw new Error('invalid demo file name')
  const src = join(demoInvoicesDir(), file)
  if (!existsSync(src)) throw new Error(`demo invoice not found: ${file}`)
  const id = newId()
  const dest = join(invoicesDir(), `${id}.pdf`)
  copyFileSync(src, dest)
  const created = invoices.create({ id, file_path: dest, status: 'queued' })
  appendAudit({ actor: 'owner', event: 'invoice.uploaded', invoiceId: created.id, details: { name: file, demo: true } })
  const { onInvoiceQueued } = await import('../integration')
  void onInvoiceQueued(created.id).catch((err: unknown) => {
    appendAudit({ actor: 'agent', event: 'pipeline.error', invoiceId: created.id, details: { message: String(err) } })
  })
  return created.id
}
