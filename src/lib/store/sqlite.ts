// Server-only. Import from server functions, API routes or scripts; never from client components.
import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import schemaSql from './schema.sql?raw'

if (typeof window !== 'undefined') {
  throw new Error('src/lib/store/sqlite.ts is server-only')
}

const migrationFiles = import.meta.glob('./migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

export function databasePath(): string {
  return resolve(process.env.DATABASE_PATH ?? './data/payroll.sqlite')
}

/** Directory for uploaded invoice PDFs: <dir of DATABASE_PATH>/invoices (lands on the Railway volume). */
export function invoicesDir(): string {
  return resolve(dirname(databasePath()), 'invoices')
}

let db: Database | null = null

export function getDb(): Database {
  if (db) return db
  const path = databasePath()
  mkdirSync(dirname(path), { recursive: true })
  mkdirSync(invoicesDir(), { recursive: true })
  const instance = new Database(path, { create: true, strict: true })
  instance.exec('PRAGMA journal_mode = WAL;')
  instance.exec('PRAGMA foreign_keys = ON;')
  instance.exec('PRAGMA busy_timeout = 5000;')
  instance.exec(schemaSql)
  applyMigrations(instance)
  db = instance
  return instance
}

function applyMigrations(instance: Database) {
  instance.exec(
    'CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
  )
  const applied = new Set(
    (instance.query('SELECT name FROM _migrations').all() as { name: string }[]).map((r) => r.name),
  )
  const names = Object.keys(migrationFiles).sort()
  for (const key of names) {
    const name = key.split('/').pop() ?? key
    if (applied.has(name)) continue
    const run = instance.transaction(() => {
      instance.exec(migrationFiles[key] ?? '')
      instance
        .query('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)')
        .run(name, new Date().toISOString())
    })
    run()
  }
}

export function pingDb(): boolean {
  try {
    const row = getDb().query('SELECT 1 AS ok').get() as { ok: number } | null
    return row?.ok === 1
  } catch {
    return false
  }
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function newId(): string {
  return crypto.randomUUID()
}
