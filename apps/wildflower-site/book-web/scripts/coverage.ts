// What a chapter's `{{#covers <path>}}` promises: that the book shows every
// item in the file worth reading. `coverableItems` lists them, and
// `coverageReport` says which no `{{#code}}`, `{{#code-link}}` or
// `{{#covered}}` anywhere in the book names. The build prints the report as
// a warning, not a failure: it says where the book has fallen behind the code.
//
// A Rust file's coverable items are its `pub` and `pub(crate)` functions,
// types, traits, consts and statics; the `pub` and `pub(crate)` functions and
// consts of its inherent `impl` blocks; and every `#[test]` function (any
// attribute whose path ends in `test`, as `#[tokio::test]`). Inline modules
// are read the same way, so a unit test is `tests::name`, and so are the
// functions of a `proptest!` block, each of which carries its `#[test]`.
import type { Node } from 'web-tree-sitter'

import { parseRust, type ParsedRust } from './rust-items.ts'

/** An item a covered file holds: its symbol, as a directive names it, and its first row. */
interface CoverableItem {
  readonly symbol: string
  /** 0-based, the row `locateRustItem` reports as the item's `startRow`. */
  readonly row: number
}

/** An item a directive names: the row it starts on in its file. */
interface ItemReference {
  /** Repo-root-relative. */
  readonly path: string
  readonly row: number
}

/** A covered file and the items it holds. */
interface CoveredFile {
  /** Repo-root-relative. */
  readonly path: string
  readonly items: readonly CoverableItem[]
}

interface CoverageReport {
  readonly total: number
  readonly referenced: number
  /** Each item no directive names, in file order. */
  readonly missing: readonly { readonly path: string; readonly symbol: string }[]
}

const PUBLIC_ITEMS: ReadonlySet<string> = new Set([
  'function_item',
  'struct_item',
  'enum_item',
  'trait_item',
  'const_item',
  'static_item',
  'type_item',
  'union_item',
])

const PUBLIC_MEMBERS: ReadonlySet<string> = new Set(['function_item', 'const_item'])

const isPublic = (node: Node): boolean => {
  const visibility = node.namedChildren.find((child) => child?.type === 'visibility_modifier')
  const text = visibility?.text.replace(/\s+/g, '')
  return text === 'pub' || text === 'pub(crate)'
}

const isTestAttribute = (node: Node): boolean =>
  node.type === 'attribute_item' && /^#\[\s*(?:\w+\s*::\s*)*test\b/.test(node.text)

const nameOf = (node: Node): string | undefined => node.childForFieldName('name')?.text

/** `Foo`, `Foo<T>` and `crate::a::Foo` all name `Foo`. */
const baseTypeName = (node: Node | null): string | undefined =>
  node?.text
    .replace(/<[\s\S]*$/, '')
    .split('::')
    .at(-1)
    ?.trim()

/** The coverable items directly in `scope` (a file or a module's body), named under `prefix`. */
const itemsIn = (parsed: ParsedRust, scope: Node, prefix: string): CoverableItem[] => {
  const items: CoverableItem[] = []
  let attributes: Node[] = []
  for (const node of parsed.itemsIn(scope)) {
    if (node.type === 'attribute_item') {
      attributes.push(node)
      continue
    }
    const attributesOfNode = attributes
    if (node.type !== 'line_comment' && node.type !== 'block_comment') attributes = []
    const name = nameOf(node)
    const row = node.startPosition.row
    if (node.type === 'mod_item') {
      const body = node.childForFieldName('body')
      if (body !== null && name !== undefined)
        items.push(...itemsIn(parsed, body, `${prefix}${name}::`))
    } else if (node.type === 'impl_item' && node.childForFieldName('trait') === null) {
      const type = baseTypeName(node.childForFieldName('type'))
      const body = node.childForFieldName('body')
      if (type === undefined || body === null) continue
      for (const member of body.namedChildren) {
        const memberName = member === null ? undefined : nameOf(member)
        if (member !== null && memberName !== undefined && PUBLIC_MEMBERS.has(member.type))
          if (isPublic(member))
            items.push({ symbol: `${prefix}${type}::${memberName}`, row: member.startPosition.row })
      }
    } else if (name !== undefined && PUBLIC_ITEMS.has(node.type)) {
      const isTest = node.type === 'function_item' && attributesOfNode.some(isTestAttribute)
      if (isTest || isPublic(node)) items.push({ symbol: `${prefix}${name}`, row })
    }
  }
  return items
}

/** The coverable items in the Rust `source`, in file order. */
const coverableItems = async (source: string): Promise<readonly CoverableItem[]> => {
  const parsed = await parseRust(source)
  try {
    return itemsIn(parsed, parsed.root, '')
  } finally {
    parsed.delete()
  }
}

/** Which of the covered files' items the book's directives name. */
const coverageReport = (
  files: readonly CoveredFile[],
  references: readonly ItemReference[]
): CoverageReport => {
  const named = new Set(references.map(({ path, row }) => `${path}:${row}`))
  let total = 0
  const missing: { path: string; symbol: string }[] = []
  for (const { path, items } of files)
    for (const { symbol, row } of items) {
      total++
      if (!named.has(`${path}:${row}`)) missing.push({ path, symbol })
    }
  return { total, referenced: total - missing.length, missing }
}

/** The report as the build prints it. */
const formatCoverage = (report: CoverageReport): string => {
  const head = `coverage: ${report.referenced}/${report.total} items`
  if (report.missing.length === 0) return `${head}; every covered item is in the book\n`
  const lines = report.missing.map(({ path, symbol }) => `  WARNING: ${path} ${symbol}`)
  return `${head}; ${report.missing.length} not in the book:\n${lines.join('\n')}\n`
}

export type { CoverableItem, CoverageReport, CoveredFile, ItemReference }
export { coverableItems, coverageReport, formatCoverage }
