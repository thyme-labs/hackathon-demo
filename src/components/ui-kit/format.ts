const eur = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 })
const eurExact = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2 })
const czk = new Intl.NumberFormat('cs-CZ', { style: 'currency', currency: 'CZK', maximumFractionDigits: 0 })

export function formatEur(value: number, exact = false): string {
  return (exact ? eurExact : eur).format(value)
}

export function formatCzk(value: number): string {
  return czk.format(value)
}

export function formatMoney(value: number | null | undefined, currency: string | null | undefined): string {
  if (value === null || value === undefined) return '—'
  try {
    return new Intl.NumberFormat('en-IE', { style: 'currency', currency: currency ?? 'EUR', minimumFractionDigits: 2 }).format(value)
  } catch {
    return `${value.toFixed(2)} ${currency ?? ''}`.trim()
  }
}

/** EURC has 6 decimals; amount_eurc is stored as a base-unit string. */
export function formatEurc(baseUnits: string | bigint): string {
  const n = typeof baseUnits === 'bigint' ? baseUnits : BigInt(baseUnits || '0')
  const whole = n / 1_000_000n
  const frac = (n % 1_000_000n).toString().padStart(6, '0').slice(0, 2)
  return `${whole.toLocaleString('en-IE')}.${frac}`
}

/** Prague wall-clock everywhere (demo venue), identical on server and client so SSR hydrates cleanly. */
const TZ = 'Europe/Prague'

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: TZ })
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: TZ })
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${formatDate(iso)} ${formatTime(iso)}`
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return 'never'
  const diff = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(diff)) return iso
  const s = Math.round(diff / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return formatDate(iso)
}

export function secondsBetween(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!a || !b) return null
  const d = (new Date(b).getTime() - new Date(a).getTime()) / 1000
  return Number.isFinite(d) ? Math.max(0, Math.round(d)) : null
}

export function formatUsd(value: number): string {
  if (value === 0) return '$0.00'
  if (value < 0.01) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}
