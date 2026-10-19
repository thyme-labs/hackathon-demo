// What is in the file that the eye does not see. A pdf-lib object and content-stream scan, no model:
// text drawn in white, below 4.5 pt or with an invisible render mode (Tr 3/7), active content (JavaScript,
// OpenAction, additional actions, Launch), incremental updates (%%EOF count) and a second wallet in the text
// layer. Strings are decoded for simple WinAnsi/Standard fonts only; glyph-id strings of embedded subsets
// (Type0 / Identity-H) are counted but never text-matched. Deterministic and offline, hence a high tier.
import { existsSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFName, type PDFPage, PDFRawStream, PDFStream } from 'pdf-lib'
import { type CheckContext, type CheckSpec, makeResult, shortAddr } from './context'
import { INSTRUCTION_LIKE } from './invoice_integrity'

const spec = { id: 'pdf_forensics', label: 'PDF forensics', enforcement: 'agent', weight: 6 } as const

const MIN_VISIBLE_PT = 4.5
const WHITE = 0.98
const ACTIVE_KEYS: ReadonlySet<string> = new Set(['JS', 'JavaScript', 'OpenAction', 'AA', 'Launch'])
const PASSIVE_KEYS: ReadonlySet<string> = new Set(['EmbeddedFile', 'EmbeddedFiles', 'XFA', 'AcroForm', 'RichMedia'])
const WALLET_RE = /0x[0-9a-fA-F]{40}/g
const MONEY_RE = /(?:€|\$|£|\b(?:EUR|USD|GBP|CZK|EURC|USDC|USDT)\b)\s?\d|\d\s?(?:€|\$|£|\b(?:EUR|USD|GBP|CZK|EURC|USDC|USDT)\b)|\b(?:total|amount due|amount|pay)\b[^.\n]{0,30}\d/i
const OCR_OVERLAP = 0.8
const SIMPLE_FONTS: ReadonlySet<string> = new Set(['Type1', 'TrueType', 'MMType1'])

type Tok = { kind: 'op' | 'num' | 'name' | 'str' | 'arr' | 'other'; value: string; items?: Tok[] }

/** Content-stream scanner: literal strings with escapes, hex strings, names, numbers, arrays, operators. */
const tokenize = (src: string): Tok[] => {
  const toks: Tok[] = []
  const arrays: Tok[][] = []
  const push = (t: Tok) => (arrays.length ? arrays[arrays.length - 1].push(t) : toks.push(t))
  const n = src.length
  const isWs = (c: string) => c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f' || c === '\0'
  const isDelim = (c: string) => '()<>[]{}/%'.includes(c)
  let i = 0
  while (i < n) {
    const c = src[i]
    if (isWs(c)) {
      i++
    } else if (c === '%') {
      while (i < n && src[i] !== '\n' && src[i] !== '\r') i++
    } else if (c === '(') {
      let depth = 1
      let out = ''
      i++
      while (i < n && depth > 0) {
        const ch = src[i]
        if (ch === '\\') {
          const nx = src[i + 1]
          if (nx === undefined) {
            i++
          } else if (/[0-7]/.test(nx)) {
            let j = i + 1
            let oct = ''
            while (j < n && j < i + 4 && /[0-7]/.test(src[j])) oct += src[j++]
            out += String.fromCharCode(Number.parseInt(oct, 8) & 0xff)
            i = j
          } else if (nx === '\r') {
            i += src[i + 2] === '\n' ? 3 : 2
          } else if (nx === '\n') {
            i += 2
          } else {
            out += ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' } as Record<string, string>)[nx] ?? nx
            i += 2
          }
        } else {
          if (ch === '(') depth++
          else if (ch === ')') depth--
          if (depth > 0) out += ch
          i++
        }
      }
      push({ kind: 'str', value: out })
    } else if (c === '<' && src[i + 1] === '<') {
      push({ kind: 'other', value: '<<' })
      i += 2
    } else if (c === '<') {
      let hex = ''
      i++
      while (i < n && src[i] !== '>') {
        if (!isWs(src[i])) hex += src[i]
        i++
      }
      i++
      if (hex.length % 2) hex += '0'
      let out = ''
      for (let k = 0; k < hex.length; k += 2) {
        const v = Number.parseInt(hex.slice(k, k + 2), 16)
        out += String.fromCharCode(Number.isNaN(v) ? 0 : v)
      }
      push({ kind: 'str', value: out })
    } else if (c === '>') {
      i += src[i + 1] === '>' ? 2 : 1
    } else if (c === '[') {
      arrays.push([])
      i++
    } else if (c === ']') {
      const items = arrays.pop() ?? []
      push({ kind: 'arr', value: '[]', items })
      i++
    } else if (c === '{' || c === '}') {
      i++
    } else if (c === '/') {
      let j = i + 1
      while (j < n && !isWs(src[j]) && !isDelim(src[j])) j++
      push({ kind: 'name', value: src.slice(i + 1, j).replace(/#([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(Number.parseInt(h, 16))) })
      i = j
    } else {
      let j = i
      while (j < n && !isWs(src[j]) && !isDelim(src[j])) j++
      const word = src.slice(i, j)
      i = j
      push(/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word) ? { kind: 'num', value: word } : { kind: 'op', value: word })
    }
  }
  return toks
}

interface FontInfo {
  readable: boolean
  subtype: string
  encoding: string | null
}

interface GState {
  fill: string
  white: boolean
  font: string
  size: number
  mode: number
  scale: number
  tmScale: number
}

interface TextOp {
  text: string | null
  font: string
  size: number
  mode: number
  fill: string
  reasons: string[]
}

const num = (t: Tok | undefined): number => (t && t.kind === 'num' ? Number(t.value) : Number.NaN)
const det = (a: number, b: number, c: number, d: number): number => Math.sqrt(Math.abs(a * d - b * c)) || 1
const cp1252 = (s: string): string => s.replace(/[\x80-\x9f]/g, (ch) => ({ '\x80': '€', '\x91': '‘', '\x92': '’', '\x93': '“', '\x94': '”', '\x96': '–', '\x97': '—', '\x85': '…' })[ch] ?? ch)

/** Walks one content stream and returns every text-showing operation with the graphics state it ran under. */
const textOps = (src: string, fonts: Map<string, FontInfo>): TextOp[] => {
  const ops: TextOp[] = []
  const stack: GState[] = []
  let g: GState = { fill: '0 g', white: false, font: '', size: 0, mode: 0, scale: 1, tmScale: 1 }
  let operands: Tok[] = []
  const show = (raw: string | null) => {
    const info = g.font ? fonts.get(g.font) : undefined
    const readable = info?.readable ?? false
    const eff = g.size * g.scale * g.tmScale
    const reasons: string[] = []
    if (g.white) reasons.push('white fill')
    if (eff > 0 && eff < MIN_VISIBLE_PT) reasons.push(`${Math.round(eff * 10) / 10} pt`)
    if (g.mode === 3 || g.mode === 7) reasons.push(`invisible render mode (Tr ${g.mode})`)
    ops.push({ text: raw !== null && readable ? cp1252(raw) : null, font: g.font, size: Math.round(eff * 10) / 10, mode: g.mode, fill: g.fill, reasons })
  }
  const setColour = (vals: number[], suffix: string) => {
    g.fill = `${vals.join(' ')} ${suffix}`
    if (vals.length === 1) g.white = vals[0] >= WHITE
    else if (vals.length === 3) g.white = vals.every((v) => v >= WHITE)
    else if (vals.length === 4) g.white = vals.every((v) => v <= 1 - WHITE)
    else g.white = false
  }
  for (const t of tokenize(src)) {
    if (t.kind !== 'op') {
      operands.push(t)
      continue
    }
    const nums = operands.filter((o) => o.kind === 'num').map((o) => Number(o.value))
    switch (t.value) {
      case 'q':
        stack.push({ ...g })
        break
      case 'Q':
        g = stack.pop() ?? g
        break
      case 'cm':
        if (nums.length >= 6) g.scale *= det(nums[0], nums[1], nums[2], nums[3])
        break
      case 'BT':
        g.tmScale = 1
        break
      case 'Tm':
        if (nums.length >= 6) g.tmScale = det(nums[0], nums[1], nums[2], nums[3])
        break
      case 'Tf': {
        const name = operands.find((o) => o.kind === 'name')
        g.font = name?.value ?? g.font
        const size = num(operands.at(-1))
        if (Number.isFinite(size)) g.size = Math.abs(size)
        break
      }
      case 'Tr':
        g.mode = num(operands.at(-1)) || 0
        break
      case 'rg':
      case 'sc':
      case 'scn':
        if (operands.some((o) => o.kind === 'name')) g.white = false
        else setColour(nums, t.value)
        break
      case 'g':
        setColour(nums.slice(-1), 'g')
        break
      case 'k':
        setColour(nums.slice(-4), 'k')
        break
      case 'Tj':
      case "'":
      case '"': {
        const s = [...operands].reverse().find((o) => o.kind === 'str')
        show(s ? s.value : null)
        break
      }
      case 'TJ': {
        const arr = [...operands].reverse().find((o) => o.kind === 'arr')
        show(arr ? (arr.items ?? []).filter((o) => o.kind === 'str').map((o) => o.value).join('') : null)
        break
      }
      default:
        break
    }
    operands = []
  }
  return ops
}

const nameOf = (v: unknown): string | null => (v instanceof PDFName ? v.decodeText() : null)

const fontTable = (doc: PDFDocument, page: PDFPage): Map<string, FontInfo> => {
  const table = new Map<string, FontInfo>()
  const res = page.node.Resources()
  const fonts = res?.lookup(PDFName.of('Font'))
  if (!(fonts instanceof PDFDict)) return table
  for (const [key, ref] of fonts.entries()) {
    const dict = doc.context.lookup(ref)
    if (!(dict instanceof PDFDict)) continue
    const subtype = nameOf(dict.get(PDFName.of('Subtype'))) ?? 'unknown'
    const encRaw = doc.context.lookup(dict.get(PDFName.of('Encoding')))
    const encoding = encRaw instanceof PDFDict ? (nameOf(encRaw.get(PDFName.of('BaseEncoding'))) ?? 'custom') : nameOf(encRaw)
    const readable = SIMPLE_FONTS.has(subtype) && !/^Identity/.test(encoding ?? '')
    table.set(key.decodeText(), { readable, subtype, encoding })
  }
  return table
}

const pageHasImage = (doc: PDFDocument, page: PDFPage): boolean => {
  const xo = page.node.Resources()?.lookup(PDFName.of('XObject'))
  if (!(xo instanceof PDFDict)) return false
  for (const [, ref] of xo.entries()) {
    const obj = doc.context.lookup(ref)
    if (obj instanceof PDFStream && nameOf(obj.dict.get(PDFName.of('Subtype'))) === 'Image') return true
  }
  return false
}

/** Decoded page content streams (latin1 so every byte maps to one char); counts streams it could not decode. */
const pageContent = (doc: PDFDocument, page: PDFPage): { text: string; undecodable: number } => {
  const raw = doc.context.lookup(page.node.get(PDFName.of('Contents')))
  const parts = raw instanceof PDFArray ? raw.asArray().map((r) => doc.context.lookup(r)) : raw ? [raw] : []
  let text = ''
  let undecodable = 0
  for (const s of parts) {
    if (!(s instanceof PDFRawStream)) {
      if (s) undecodable++
      continue
    }
    try {
      text += `${Buffer.from(decodePDFRawStream(s).decode()).toString('latin1')}\n`
    } catch {
      undecodable++
    }
  }
  return { text, undecodable }
}

/** Dictionary keys of every object, including direct sub-dictionaries (the catalog's Names tree, actions). */
const collectKeys = (doc: PDFDocument): Set<string> => {
  const keys = new Set<string>()
  const walk = (dict: PDFDict, depth: number) => {
    for (const [k, v] of dict.entries()) {
      keys.add(k.decodeText())
      if (depth === 0) continue
      if (v instanceof PDFDict) walk(v, depth - 1)
      else if (v instanceof PDFArray) for (const el of v.asArray()) if (el instanceof PDFDict) walk(el, depth - 1)
    }
  }
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    const dict = obj instanceof PDFDict ? obj : obj instanceof PDFStream ? obj.dict : null
    if (dict) walk(dict, 3)
  }
  walk(doc.catalog, 3)
  return keys
}

const tokensOf = (s: string): Set<string> => new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 2))

const safeMeta = (fn: () => string | undefined): string | null => {
  try {
    return fn() ?? null
  } catch {
    return null
  }
}

export const run = async (ctx: CheckContext) => {
  const path = ctx.invoice.file_path
  const sourceBase = 'PDF object/content-stream scan (pdf-lib), no model'
  if (!path || !existsSync(path)) {
    return makeResult(spec, ctx, { status: 'skip', evidence: 'No PDF on disk for this invoice (stored extraction only); nothing to scan.', source: sourceBase })
  }
  const buffer = readFileSync(path)
  const bytes = new Uint8Array(buffer)
  let doc: PDFDocument
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return makeResult(spec, ctx, { status: 'skip', evidence: `Could not parse the PDF structure (${msg.slice(0, 120)}).`, source: `${sourceBase}; file ${basename(path)}, ${bytes.length} B` })
  }
  const producer = safeMeta(() => doc.getProducer())
  const source = `${sourceBase}; file ${basename(path)}, ${bytes.length} B, producer ${producer ?? 'n/a'}`
  const eofCount = (buffer.toString('latin1').match(/%%EOF/g) ?? []).length

  const keys = collectKeys(doc)
  const active = [...keys].filter((k) => ACTIVE_KEYS.has(k)).sort()
  const passive = [...keys].filter((k) => PASSIVE_KEYS.has(k)).sort()

  const ops: TextOp[] = []
  let undecodable = 0
  let anyImage = false
  for (const page of doc.getPages()) {
    const fonts = fontTable(doc, page)
    const content = pageContent(doc, page)
    undecodable += content.undecodable
    anyImage = anyImage || pageHasImage(doc, page)
    ops.push(...textOps(content.text, fonts))
  }
  const hidden = ops.filter((o) => o.reasons.length > 0)
  const unreadable = ops.filter((o) => o.text === null).length
  const allText = ops.map((o) => o.text ?? '').join('\n')
  const wallets = [...new Set((allText.match(WALLET_RE) ?? []).map((w) => w.toLowerCase()))]
  const hiddenText = hidden.map((o) => o.text).filter((t): t is string => t !== null && t.trim().length > 0).join(' ').replace(/\s+/g, ' ').trim()
  const why = [...new Set(hidden.flatMap((o) => o.reasons))].join(', ')

  // Invisible text over a scanned page that repeats the visible content is an OCR layer, not a payload.
  const visibleTokens = tokensOf(
    [ctx.extracted.payee.name, ctx.extracted.payee.address, ctx.extracted.invoice.number, ctx.extracted.notes ?? '', ...ctx.extracted.invoice.line_items.map((l) => l.description)].join(' '),
  )
  const hiddenTokens = [...tokensOf(hiddenText)]
  const overlap = hiddenTokens.length ? hiddenTokens.filter((t) => visibleTokens.has(t)).length / hiddenTokens.length : 0
  const ocrLayer = hidden.length > 0 && hidden.every((o) => o.mode === 3 || o.mode === 7) && anyImage && overlap >= OCR_OVERLAP

  const payload = hiddenText.length > 0 && (INSTRUCTION_LIKE.test(hiddenText) || WALLET_RE.test(hiddenText) || MONEY_RE.test(hiddenText))
  WALLET_RE.lastIndex = 0
  const snippet = hiddenText ? `"${hiddenText.slice(0, 120)}${hiddenText.length > 120 ? '…' : ''}"` : '[glyph strings of an embedded font, not decodable as text]'

  const data = {
    pages: doc.getPageCount(),
    text_ops: ops.length,
    unreadable_ops: unreadable,
    undecodable_streams: undecodable,
    hidden_ops: hidden.length,
    hidden: hidden.slice(0, 10).map((o) => ({ why: o.reasons, text: o.text?.slice(0, 200) ?? null, font: o.font, size: o.size, mode: o.mode, fill: o.fill })),
    ocr_layer: ocrLayer,
    ocr_overlap: Math.round(overlap * 100) / 100,
    active_keys: active,
    passive_keys: passive,
    eof_count: eofCount,
    wallets,
    producer,
    creator: safeMeta(() => doc.getCreator()),
  }

  const fails: string[] = []
  const warns: string[] = []
  const notes: string[] = []
  if (payload) {
    fails.push(`Hidden text (${why}, ${hidden.length} op${hidden.length === 1 ? '' : 's'}): ${snippet}. The agent never reads it as an instruction; the document is rejected.`)
  } else if (hidden.length > 0 && ocrLayer) {
    notes.push(`invisible OCR text layer over a scanned page (${hidden.length} ops, ${Math.round(overlap * 100)} % overlap with the visible text)`)
  } else if (hidden.length > 0) {
    warns.push(`Hidden text present (${why}, ${hidden.length} op${hidden.length === 1 ? '' : 's'}): ${snippet}.`)
  }
  if (active.length > 0) warns.push(`Active content in the PDF (${active.join(', ')}); invoices never need it.`)
  if (passive.length > 0) notes.push(`contains ${passive.join(', ')}`)
  if (eofCount > 1) notes.push(`incrementally updated ${eofCount - 1}× (${eofCount} %%EOF markers)`)
  if (wallets.length >= 2) warns.push(`Two wallets printed (${wallets.slice(0, 2).map(shortAddr).join(', ')}${wallets.length > 2 ? ` and ${wallets.length - 2} more` : ''}); only the registry wallet can be paid.`)
  if (undecodable > 0) notes.push(`${undecodable} content stream(s) could not be decoded`)
  const noteText = notes.length ? ` Also: ${notes.join('; ')}.` : ''

  if (fails.length > 0) {
    return makeResult(spec, ctx, { status: 'fail', evidence: `${[...fails, ...warns].join(' ')}${noteText}`, source, data })
  }
  if (warns.length > 0) {
    return makeResult(spec, ctx, { status: 'warn', evidence: `${warns.join(' ')}${noteText}`, source, data })
  }
  const walletText = wallets.length === 1 ? 'one wallet in the text layer' : 'no readable wallet in the text layer'
  const fontNote = unreadable > 0 ? ` (${unreadable} in an embedded-font subset, counted but not text-matched)` : ''
  return makeResult(spec, ctx, {
    status: 'pass',
    evidence: `${ops.length} text operations, all visible${fontNote}; no active content; ${eofCount === 1 ? 'single revision' : `${eofCount} revisions`}; ${walletText}.${noteText}`,
    source,
    data,
  })
}

export const pdfForensics: CheckSpec = { ...spec, run }
