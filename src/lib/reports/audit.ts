// Append-only JSON Lines audit log with a sha256 hash chain.
//
// One line per event. Stable envelope:
//   { id, ts, actor, event, invoice_id, beneficiary_id, model_id?, prompt_hash?, details, prev_hash, hash }
// `hash` = sha256(prev_hash + canonical JSON of the record without `hash`), so
// anyone can verify the file was not edited (`verifyChain`).
// Redaction: keys that look like secrets are replaced before writing; never log
// API keys, RPC URLs or full invoice PDFs, only hashes and extracted fields.

import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AuditActor } from './types';

export interface AuditEntry {
  ts: string; // ISO-8601, ms precision, UTC
  actor: AuditActor;
  event: string;
  invoice_id: string | null;
  beneficiary_id: string | null;
  model_id?: string;
  prompt_hash?: string;
  details: Record<string, unknown>;
}

export interface AuditRecord extends AuditEntry {
  id: string;
  prev_hash: string;
  hash: string;
}

export type AuditInput = Omit<AuditEntry, 'ts' | 'invoice_id' | 'beneficiary_id' | 'details'> & {
  ts?: string;
  invoice_id?: string | null;
  beneficiary_id?: string | null;
  details?: Record<string, unknown>;
};

export const GENESIS_HASH = '0'.repeat(64);

const SECRET_KEY_PATTERN = /(api[_-]?key|secret|token|password|private[_-]?key|authorization|rpc[_-]?url|cookie)/i;
const URL_WITH_KEY = /(https?:\/\/[^\s"']*(?:key|token|apikey)=)[^\s&"']+/gi;

/** Resolve the log file: AUDIT_LOG_PATH, else next to DATABASE_PATH, else ./data/audit.jsonl. */
export function auditLogPath(): string {
  const explicit = process.env.AUDIT_LOG_PATH;
  if (explicit) return explicit;
  const db = process.env.DATABASE_PATH;
  if (db) return join(dirname(db), 'audit.jsonl');
  return join(process.cwd(), 'data', 'audit.jsonl');
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Stable hash of a prompt (system + user parts), for `prompt_hash`. */
export function promptHash(...parts: string[]): string {
  return sha256Hex(parts.join('\n---\n'));
}

/** Deterministic JSON with sorted keys so hashes are reproducible. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}

/** Replace secret-looking keys and query-string keys in nested details. */
export function redact<T>(value: T): T {
  return redactInner(value) as T;
}

function redactInner(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(URL_WITH_KEY, '$1[redacted]');
  if (Array.isArray(value)) return value.map(redactInner);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_PATTERN.test(key) ? '[redacted]' : redactInner(v);
    }
    return out;
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}

const lastHashByPath = new Map<string, string>();

function readLastHash(path: string): string {
  const cached = lastHashByPath.get(path);
  if (cached) return cached;
  if (!existsSync(path)) return GENESIS_HASH;
  const content = readFileSync(path, 'utf8');
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return GENESIS_HASH;
  try {
    const last = JSON.parse(lines[lines.length - 1] ?? '{}') as Partial<AuditRecord>;
    return typeof last.hash === 'string' ? last.hash : GENESIS_HASH;
  } catch {
    return GENESIS_HASH;
  }
}

function computeHash(record: Omit<AuditRecord, 'hash'>): string {
  return sha256Hex(record.prev_hash + canonicalJson(record));
}

/** Append one event. Returns the stored record (with id, prev_hash, hash). */
export function appendJsonl(input: AuditInput, path: string = auditLogPath()): AuditRecord {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const prev = readLastHash(path);
  const base: Omit<AuditRecord, 'hash'> = {
    id: randomUUID(),
    ts: input.ts ?? new Date().toISOString(),
    actor: input.actor,
    event: input.event,
    invoice_id: input.invoice_id ?? null,
    beneficiary_id: input.beneficiary_id ?? null,
    ...(input.model_id ? { model_id: input.model_id } : {}),
    ...(input.prompt_hash ? { prompt_hash: input.prompt_hash } : {}),
    details: redact(input.details ?? {}),
    prev_hash: prev,
  };
  const record: AuditRecord = { ...base, hash: computeHash(base) };
  appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
  lastHashByPath.set(path, record.hash);
  return record;
}

/** Demo reset only: truncate the log and forget the cached chain head so the next append starts a new chain. */
export function resetJsonl(path: string = auditLogPath()): void {
  if (existsSync(path)) writeFileSync(path, '', 'utf8');
  lastHashByPath.delete(path);
}

export interface AuditFilter {
  invoice_id?: string;
  beneficiary_id?: string;
  actor?: AuditActor;
  event?: string | RegExp;
  since?: string | Date;
  until?: string | Date;
  limit?: number;
}

/** Read every record (oldest first), optionally filtered. Malformed lines are skipped. */
export function readAll(path: string = auditLogPath(), filter: AuditFilter = {}): AuditRecord[] {
  if (!existsSync(path)) return [];
  const content = readFileSync(path, 'utf8');
  const records: AuditRecord[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as AuditRecord);
    } catch {
      // skip malformed line
    }
  }
  const since = filter.since ? new Date(filter.since).getTime() : null;
  const until = filter.until ? new Date(filter.until).getTime() : null;
  const out = records.filter((r) => {
    if (filter.invoice_id && r.invoice_id !== filter.invoice_id) return false;
    if (filter.beneficiary_id && r.beneficiary_id !== filter.beneficiary_id) return false;
    if (filter.actor && r.actor !== filter.actor) return false;
    if (filter.event) {
      if (typeof filter.event === 'string' ? r.event !== filter.event : !filter.event.test(r.event)) return false;
    }
    const t = new Date(r.ts).getTime();
    if (since !== null && t < since) return false;
    if (until !== null && t > until) return false;
    return true;
  });
  return filter.limit ? out.slice(-filter.limit) : out;
}

export interface ChainVerification {
  ok: boolean;
  count: number;
  brokenAt: number | null; // 0-based index of the first bad record
  reason: string | null;
}

/** Recompute every hash and check the chain links. */
export function verifyChain(path: string = auditLogPath()): ChainVerification {
  const records = readAll(path);
  let prev = GENESIS_HASH;
  for (let i = 0; i < records.length; i += 1) {
    const r = records[i] as AuditRecord;
    if (r.prev_hash !== prev) return { ok: false, count: records.length, brokenAt: i, reason: 'prev_hash mismatch' };
    const { hash, ...rest } = r;
    if (computeHash(rest) !== hash) return { ok: false, count: records.length, brokenAt: i, reason: 'hash mismatch' };
    prev = hash;
  }
  return { ok: true, count: records.length, brokenAt: null, reason: null };
}

/** Serialise records back to JSONL (for the download route). */
export function toJsonl(records: AuditRecord[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
}
