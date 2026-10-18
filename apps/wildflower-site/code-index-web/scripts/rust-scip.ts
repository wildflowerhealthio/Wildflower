// Rust packages, from rust-analyzer's SCIP index (`rust-analyzer scip .` at
// the workspace root). The index carries every definition and reference, each
// definition's full span, and the doc comments.
import { readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Schema } from 'effect'
import protobuf from 'protobufjs'

import {
  type FileEntry,
  type Item,
  type PackageIndex,
  Uses,
  isTestPath,
  owningPackage,
  packageName,
  trimDoc,
} from './model.ts'

type Range = [number, number, number, number]
interface Occurrence {
  readonly range: Range
  readonly symbol: string
  readonly roles: number
  readonly enclosing?: Range
}
interface Document {
  readonly path: string
  readonly occurrences: readonly Occurrence[]
  readonly symbols: readonly SymbolInfo[]
}

// The parts of a decoded `scip.Index` the index reads.
const ScipRange = Schema.Array(Schema.Number)
const SymbolInfo = Schema.Struct({
  symbol: Schema.String,
  documentation: Schema.optional(Schema.Array(Schema.String)),
  kind: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
  signatureDocumentation: Schema.optional(Schema.Struct({ text: Schema.optional(Schema.String) })),
})
type SymbolInfo = typeof SymbolInfo.Type
const ScipIndex = Schema.Struct({
  metadata: Schema.optional(Schema.Struct({ projectRoot: Schema.optional(Schema.String) })),
  documents: Schema.optional(
    Schema.Array(
      Schema.Struct({
        relativePath: Schema.String,
        symbols: Schema.optional(Schema.Array(SymbolInfo)),
        occurrences: Schema.optional(
          Schema.Array(
            Schema.Struct({
              range: ScipRange,
              symbol: Schema.String,
              symbolRoles: Schema.optional(Schema.Number),
              enclosingRange: Schema.optional(ScipRange),
            })
          )
        ),
      })
    )
  ),
})

const DEFINITION = 1
/** A SCIP range is `[line, start, end]` on one line, or `[startLine, start, endLine, end]`. */
const toRange = (r: readonly number[]): Range =>
  r.length === 3 ? [r[0], r[1], r[0], r[2]] : [r[0], r[1], r[2], r[3]]

/** Reads a SCIP index, with document paths made repo-relative. */
const loadScip = async (protoPath: string, file: string, repoRoot: string): Promise<Document[]> => {
  const root = await protobuf.load(protoPath)
  const Index = root.lookupType('scip.Index')
  const index = Schema.decodeUnknownSync(ScipIndex)(
    Index.toObject(Index.decode(readFileSync(file)), {
      longs: Number,
      enums: String,
      defaults: false,
    })
  )
  const projectRoot =
    decodeURIComponent((index.metadata?.projectRoot ?? '').replace(/^file:\/\//, '')) || repoRoot
  return (index.documents ?? []).map((d) => ({
    path: relative(repoRoot, join(projectRoot, d.relativePath)),
    symbols: d.symbols ?? [],
    occurrences: (d.occurrences ?? []).map((o) => ({
      range: toRange(o.range),
      symbol: o.symbol,
      roles: o.symbolRoles ?? 0,
      enclosing: o.enclosingRange ? toRange(o.enclosingRange) : undefined,
    })),
  }))
}

// SCIP symbol grammar: `<scheme> <manager> <package> <version> <descriptors>`.
type Suffix =
  | 'namespace'
  | 'type'
  | 'term'
  | 'method'
  | 'typeParameter'
  | 'parameter'
  | 'meta'
  | 'macro'
interface Descriptor {
  name: string
  suffix: Suffix
}

interface ParsedSymbol {
  readonly package: string
  readonly descriptors: Descriptor[]
}

const parseCache = new Map<string, ParsedSymbol | undefined>()
const parseSymbol = (symbol: string): ParsedSymbol | undefined => {
  if (parseCache.has(symbol)) return parseCache.get(symbol)
  const parsed = parseSymbolUncached(symbol)
  parseCache.set(symbol, parsed)
  return parsed
}
const parseSymbolUncached = (symbol: string): ParsedSymbol | undefined => {
  if (symbol.startsWith('local ')) return undefined
  // Fields are space-separated; a literal space is written as two.
  const fields: string[] = []
  let i = 0
  let cur = ''
  while (i < symbol.length && fields.length < 4) {
    if (symbol[i] === ' ') {
      if (symbol[i + 1] === ' ') {
        cur += ' '
        i += 2
        continue
      }
      fields.push(cur)
      cur = ''
      i++
      continue
    }
    cur += symbol[i++]
  }
  const rest = symbol.slice(i)
  const descriptors: Descriptor[] = []
  let j = 0
  const readName = (): string => {
    let name = ''
    if (rest[j] === '`') {
      j++
      while (j < rest.length) {
        if (rest[j] === '`' && rest[j + 1] === '`') {
          name += '`'
          j += 2
        } else if (rest[j] === '`') {
          j++
          break
        } else name += rest[j++]
      }
      return name
    }
    while (j < rest.length && /[\w$+-]/.test(rest[j])) name += rest[j++]
    return name
  }
  while (j < rest.length) {
    if (rest[j] === '[' || rest[j] === '(') {
      const suffix = rest[j] === '[' ? 'typeParameter' : 'parameter'
      j++
      const name = readName()
      j++
      descriptors.push({ name, suffix })
      continue
    }
    const name = readName()
    const c = rest[j++]
    if (c === '/') descriptors.push({ name, suffix: 'namespace' })
    else if (c === '#') descriptors.push({ name, suffix: 'type' })
    else if (c === '.') descriptors.push({ name, suffix: 'term' })
    else if (c === ':') descriptors.push({ name, suffix: 'meta' })
    else if (c === '!') descriptors.push({ name, suffix: 'macro' })
    else if (c === '(') {
      while (j < rest.length && rest[j] !== ')') j++
      j += 2
      descriptors.push({ name, suffix: 'method' })
    } else break
  }
  return { package: fields[2] ?? '', descriptors }
}

/** How many descriptors make up the top-level item a symbol belongs to, or 0 for a namespace. */
const topLength = (ds: Descriptor[]): number => {
  let k = 0
  while (k < ds.length && ds[k].suffix === 'namespace') k++
  if (k === ds.length) return 0
  let end = k + 1
  // A Rust `impl#[Type][Trait]` is named by its brackets.
  if (ds[k].name === 'impl' && ds[k].suffix === 'type')
    while (end < ds.length && ds[end].suffix === 'typeParameter') end++
  return end
}
const keyOf = (pkg: string, ds: Descriptor[]): string =>
  `${pkg} ${ds.map((d) => `${d.suffix}:${d.name}`).join(' ')}`

/** The key of the top-level item a symbol belongs to; undefined for a module. */
const topLevelKey = (symbol: string): string | undefined => {
  const p = parseSymbol(symbol)
  if (!p) return undefined
  const n = topLength(p.descriptors)
  return n ? keyOf(p.package, p.descriptors.slice(0, n)) : undefined
}
const isTopLevel = (symbol: string): boolean => {
  const p = parseSymbol(symbol)
  return !!p && topLength(p.descriptors) === p.descriptors.length
}
const isModuleSymbol = (symbol: string): boolean => {
  const ds = parseSymbol(symbol)?.descriptors ?? []
  return ds.length > 0 && ds.every((d) => d.suffix === 'namespace')
}
const implName = (symbol: string): string | undefined => {
  const ds = parseSymbol(symbol)?.descriptors ?? []
  const k = ds.findIndex((d) => d.suffix !== 'namespace')
  if (k < 0 || ds[k].name !== 'impl' || ds[k].suffix !== 'type') return undefined
  const params = ds.slice(k + 1, topLength(ds)).map((d) => d.name)
  return params.length >= 2 ? `impl ${params[1]} for ${params[0]}` : `impl ${params[0] ?? '?'}`
}
const namespacesOf = (symbol: string): string[] =>
  (parseSymbol(symbol)?.descriptors ?? [])
    .filter((d) => d.suffix === 'namespace')
    .map((d) => d.name)

/** Line numbers of `use` statements, whose references aren't uses. `pub use` re-exports count. */
const importStatementLines = (text: string): Set<number> => {
  const out = new Set<number>()
  let inUse = false
  text.split('\n').forEach((l, n) => {
    const t = l.trim()
    if (!inUse && /^(pub\([^)]*\)\s+)?use\s/.test(t)) inUse = true
    if (inUse) {
      out.add(n)
      if (t.endsWith(';')) inUse = false
    }
  })
  return out
}

const contains = (outer: Range, l: number, c: number): boolean =>
  (l > outer[0] || (l === outer[0] && c >= outer[1])) &&
  (l < outer[2] || (l === outer[2] && c <= outer[3]))
const rangeSize = (r: Range): number => (r[2] - r[0]) * 100000 + (r[3] - r[1])

interface Span {
  key: string
  symbol: string
  span: Range
}

/** A Rust index over the whole workspace, answering per package. */
/** Indexes the workspace's Rust from a SCIP index; the result indexes one package. */
const rustIndex = async (
  scipPath: string,
  repoRoot: string,
  commit: string
): Promise<(pkg: string) => PackageIndex> => {
  const docs = await loadScip(
    join(dirname(fileURLToPath(import.meta.url)), 'scip.proto'),
    scipPath,
    repoRoot
  )
  const symbolInfo = new Map<string, SymbolInfo>()
  for (const d of docs) for (const s of d.symbols) symbolInfo.set(s.symbol, s)
  const text = new Map<string, string>()
  const source = (path: string): string => {
    let t = text.get(path)
    if (t === undefined) text.set(path, (t = readFileSync(join(repoRoot, path), 'utf8')))
    return t
  }

  // Each document's top-level spans, and where every symbol is defined.
  const spansByDoc = new Map<string, Span[]>()
  const defAt = new Map<string, { path: string; line: number; char: number }>()
  for (const d of docs) {
    const tops = d.occurrences.filter((o) => o.roles & DEFINITION && isTopLevel(o.symbol))
    for (const o of d.occurrences)
      if (o.roles & DEFINITION && !o.symbol.startsWith('local '))
        defAt.set(o.symbol, { path: d.path, line: o.range[0], char: o.range[1] })
    // rust-analyzer defines an `impl` block's members but not the block,
    // so an impl's span runs from its `impl` line to its last member.
    const own = new Set(tops.map((o) => topLevelKey(o.symbol)))
    const impls = new Map<string, { symbol: string; start: number; end: number }>()
    for (const o of d.occurrences) {
      if (!(o.roles & DEFINITION)) continue
      const key = topLevelKey(o.symbol)
      if (!key || own.has(key) || !implName(o.symbol)) continue
      const s = o.enclosing ?? o.range
      const seen = impls.get(key)
      impls.set(
        key,
        seen
          ? { ...seen, start: Math.min(seen.start, s[0]), end: Math.max(seen.end, s[2]) }
          : { symbol: o.symbol, start: s[0], end: s[2] }
      )
    }
    if (impls.size) {
      const lines = source(d.path).split('\n')
      for (const impl of impls.values()) {
        let start = impl.start
        while (start > 0 && !/^\s*(unsafe\s+)?impl\b/.test(lines[start] ?? '')) start--
        tops.push({
          symbol: impl.symbol,
          roles: DEFINITION,
          range: [start, 0, start, 0],
          enclosing: [start, 0, impl.end, 99999],
        })
      }
    }
    const sorted = tops.toSorted((a, b) => a.range[0] - b.range[0])
    spansByDoc.set(
      d.path,
      sorted.map((o, n) => {
        const next = sorted[n + 1]
        const span: Range = o.enclosing ?? [
          o.range[0],
          0,
          next ? Math.max(o.range[0], next.range[0] - 1) : o.range[0] + 1,
          99999,
        ]
        return { key: topLevelKey(o.symbol)!, symbol: o.symbol, span }
      })
    )
  }
  const spanAt = (path: string, l: number, c: number): Span | undefined => {
    let best: Span | undefined
    for (const s of spansByDoc.get(path) ?? [])
      if (contains(s.span, l, c) && (!best || rangeSize(s.span) < rangeSize(best.span))) best = s
    return best
  }

  return (pkg: string): PackageIndex => {
    const pkgDocs = docs
      .filter((d) => d.path.startsWith(pkg + '/'))
      .toSorted((a, b) => a.path.localeCompare(b.path))
    const files: FileEntry[] = []
    const items = new Map<string, Item>()
    const itemOfKey = new Map<string, string>() // `<path>\u0000<top-level key>` → item id

    for (const d of pkgDocs) {
      const rel = relative(pkg, d.path)
      const fileTest = isTestPath(rel)
      const moduleDef = d.occurrences.find(
        (o) =>
          o.roles & DEFINITION && isModuleSymbol(o.symbol) && o.range[0] === 0 && o.range[1] === 0
      )
      files.push({
        path: rel,
        doc: trimDoc((symbolInfo.get(moduleDef?.symbol ?? '')?.documentation ?? []).join('\n\n')),
        lines: source(d.path).split('\n').length,
        test: fileTest,
      })
      items.set(`${rel}#`, {
        id: `${rel}#`,
        file: rel,
        name: '(module scope)',
        kind: 'Module',
        line: 0,
        endLine: 0,
        doc: '',
        signature: '',
        exported: false,
        test: fileTest,
      })
      // Items a macro generates share its span: one `diesel::table!` defines a
      // module and a column each. They're one item, named by the macro call.
      const bySpan = new Map<string, Span[]>()
      for (const s of spansByDoc.get(d.path) ?? []) {
        const k = `${s.span[0]}:${s.span[1]}:${s.span[2]}:${s.span[3]}`
        bySpan.set(k, [...(bySpan.get(k) ?? []), s])
      }
      const lines = source(d.path).split('\n')
      for (const group of bySpan.values()) {
        if (group.length < 2) continue
        const s = group[0]
        const call = (lines[s.span[0]] ?? '').trim().replace(/\s*[{(]\s*$/, '')
        const next = (lines[s.span[0] + 1] ?? '').trim().replace(/\s*[{(].*$/, '')
        const name = call.endsWith('!') && next ? `${call} ${next}` : call || '(macro)'
        let id = `${rel}#${name}`
        for (let k = 2; items.has(id); k++) id = `${rel}#${name}~${k}`
        items.set(id, {
          id,
          file: rel,
          name,
          kind: 'Macro call',
          line: s.span[0] + 1,
          endLine: s.span[2] + 1,
          doc: '',
          signature: '',
          exported: false,
          test: fileTest || namespacesOf(s.symbol).includes('tests'),
        })
        for (const g of group) itemOfKey.set(`${d.path}\u0000${g.key}`, id)
      }
      for (const s of spansByDoc.get(d.path) ?? []) {
        if (itemOfKey.has(`${d.path}\u0000${s.key}`)) continue
        const impl = implName(s.symbol)
        const info = impl ? undefined : symbolInfo.get(s.symbol)
        const name =
          impl ??
          info?.displayName ??
          parseSymbol(s.symbol)!.descriptors.find((x) => x.suffix !== 'namespace')?.name ??
          '?'
        const sig = info?.signatureDocumentation?.text ?? ''
        let doc = (info?.documentation ?? []).join('\n\n')
        if (doc.startsWith('*This is the documentation for*')) doc = ''
        const ns = namespacesOf(s.symbol)
        let id = `${rel}#${name}`
        for (let k = 2; items.has(id); k++) id = `${rel}#${name}~${k}`
        items.set(id, {
          id,
          file: rel,
          name,
          kind: impl ? 'Impl' : (info?.kind ?? '?'),
          line: s.span[0] + 1,
          endLine: s.span[2] + 1,
          doc: trimDoc(doc),
          signature: sig,
          exported: /^pub\s/.test(sig),
          test: fileTest || ns.includes('tests') || ns.includes('test'),
        })
        itemOfKey.set(`${d.path}\u0000${s.key}`, id)
      }
    }

    // The item a symbol belongs to: its top-level item, found where that is defined.
    const targetOf = (symbol: string): string | undefined => {
      const def = defAt.get(symbol)
      if (!def || !def.path.startsWith(pkg + '/')) return undefined
      const s = spanAt(def.path, def.line, def.char)
      return s ? itemOfKey.get(`${def.path}\u0000${s.key}`) : undefined
    }

    const uses = new Uses()
    for (const d of docs) {
      const fromPkg = d.path.startsWith(pkg + '/')
      const rel = relative(pkg, d.path)
      const skip = fromPkg ? importStatementLines(source(d.path)) : undefined
      for (const o of d.occurrences) {
        if (o.roles & DEFINITION || isModuleSymbol(o.symbol) || o.symbol.startsWith('local '))
          continue
        const target = targetOf(o.symbol)
        if (!target) continue
        if (!fromPkg) {
          uses.externalUse(target, owningPackage(repoRoot, d.path) ?? d.path)
          continue
        }
        if (skip!.has(o.range[0])) continue
        const s = spanAt(d.path, o.range[0], o.range[1])
        const from = (s && itemOfKey.get(`${d.path}\u0000${s.key}`)) ?? `${rel}#`
        if (from === target) continue
        if (items.get(from)!.test) uses.testUse(target)
        else uses.internalUse(from, target)
      }
    }
    const edges = uses.edges()
    const touched = new Set(edges.flatMap((e) => [e.from, e.to]))
    for (const [id, it] of items) if (it.kind === 'Module' && !touched.has(id)) items.delete(id)
    return {
      package: {
        name: packageName(repoRoot, pkg),
        path: pkg,
        language: 'rust',
        commit,
        repository: 'wildflowerhealthio/Wildflower',
      },
      files,
      items: [...items.values()],
      edges,
      testUses: Object.fromEntries(uses.testUses),
      externalUses: Object.fromEntries(
        [...uses.externalUses].map(([k, m]) => [k, Object.fromEntries(m)])
      ),
    }
  }
}

export { rustIndex }
