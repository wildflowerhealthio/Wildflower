// What a chapter's `{{#covers <path>}}` promises: that the book shows every
// item in the file worth reading. `coverableFile` lists them, and
// `coverageReport` says which no `{{#code}}`, `{{#code-link}}`, `{{#item}}`
// or `{{#covered}}` anywhere in the book names. The build prints the report
// as warnings, not a failure: it says where the book has fallen behind the
// code. Two more lists ride along: the covered items, fields and variants
// with no doc comment (an `{{#item}}` shows its prose from the doc comment),
// and the tests no `{{#item tests=…}}` or `{{#code}}` shows.
//
// A Rust file's coverable items are its `pub` and `pub(crate)` functions,
// types, traits, consts and statics; the `pub` and `pub(crate)` functions and
// consts of its inherent `impl` blocks; and every `#[test]` function (any
// attribute whose path ends in `test`, as `#[tokio::test]`). Inline modules
// are read the same way, so a unit test is `tests::name`, and so are the
// functions of a `proptest!` block, each of which carries its `#[test]`.
import type { Node } from 'web-tree-sitter'

import { docCommentOf, innerDocCommentOf, parseRust, type ParsedRust } from './rust-items.ts'

/** An item a covered file holds: its symbol, as a directive names it, and its first row. */
interface CoverableItem {
  readonly symbol: string
  /** 0-based, the row `locateRustItem` reports as the item's `startRow`. */
  readonly row: number
  /** A test function (`#[test]`, `#[tokio::test]`, a proptest). */
  readonly isTest: boolean
  readonly documented: boolean
}

/**
 * A named field or variant of a coverable struct or enum, named as rustdoc
 * links it: `Type::field`, `Enum::Variant`, `Enum::Variant::field`.
 */
interface CoverableMember {
  readonly symbol: string
  readonly kind: 'field' | 'variant'
  readonly documented: boolean
}

/** What a covered file holds. */
interface Coverable {
  /** In file order. */
  readonly items: readonly CoverableItem[]
  /** In file order. */
  readonly members: readonly CoverableMember[]
  /** Whether the file opens with its own `//!` doc, which `{{#item <path> self}}` shows. */
  readonly moduleDocumented: boolean
}

/** An item a directive names: the row it starts on in its file. */
interface ItemReference {
  /** Repo-root-relative. */
  readonly path: string
  readonly row: number
  /** The directive shows its source: `{{#code}}` or `{{#item}}`, not `{{#code-link}}` or `{{#covered}}`. */
  readonly shown: boolean
}

/** A covered file and what it holds. */
interface CoveredFile extends Coverable {
  /** Repo-root-relative. */
  readonly path: string
}

/** A file's module, item, test, field or variant with no doc comment. A module is `self`. */
interface Undocumented {
  readonly path: string
  readonly symbol: string
  readonly kind: 'module' | 'item' | 'test' | 'field' | 'variant'
}

interface CoverageReport {
  readonly total: number
  readonly referenced: number
  /** Each item no directive names, in file order. */
  readonly missing: readonly { readonly path: string; readonly symbol: string }[]
  /** Each item, test, field and variant without a doc comment, in file order. */
  readonly undocumented: readonly Undocumented[]
  /** The covered files' tests. */
  readonly tests: number
  /** Each test no `{{#item tests=…}}` or `{{#code}}` shows, in file order. */
  readonly unshownTests: readonly { readonly path: string; readonly symbol: string }[]
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

/** Doc comments sit before a field, past its attributes and visibility. */
const isDocumented = (node: Node): boolean => docCommentOf(node) !== ''

/**
 * The named fields in a struct's or variant's body, as members of `owner`. A
 * tuple's positional fields (`Tuple::0`) aren't listed: rustdoc can't link
 * them usefully, and the type's or variant's own doc comment covers them.
 */
const fieldsOf = (body: Node | null, owner: string): CoverableMember[] => {
  if (body?.type !== 'field_declaration_list') return []
  return body.namedChildren.flatMap((field) => {
    const name = field?.type === 'field_declaration' ? nameOf(field) : undefined
    return field === null || name === undefined
      ? []
      : [{ symbol: `${owner}::${name}`, kind: 'field' as const, documented: isDocumented(field) }]
  })
}

/** The fields of a struct or union, or the variants of an enum and their fields. */
const membersOf = (node: Node, owner: string): CoverableMember[] => {
  const body = node.childForFieldName('body')
  if (node.type === 'struct_item' || node.type === 'union_item') return fieldsOf(body, owner)
  if (node.type !== 'enum_item') return []
  return (body?.namedChildren ?? []).flatMap((variant) => {
    const name = variant?.type === 'enum_variant' ? nameOf(variant) : undefined
    if (variant === null || name === undefined) return []
    return [
      { symbol: `${owner}::${name}`, kind: 'variant' as const, documented: isDocumented(variant) },
      ...fieldsOf(variant.childForFieldName('body'), `${owner}::${name}`),
    ]
  })
}

/** What is coverable directly in `scope` (a file or a module's body), named under `prefix`. */
const coverableIn = (
  parsed: ParsedRust,
  scope: Node,
  prefix: string
): Omit<Coverable, 'moduleDocumented'> => {
  const items: CoverableItem[] = []
  const members: CoverableMember[] = []
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
      if (body !== null && name !== undefined) {
        const inner = coverableIn(parsed, body, `${prefix}${name}::`)
        items.push(...inner.items)
        members.push(...inner.members)
      }
    } else if (node.type === 'impl_item' && node.childForFieldName('trait') === null) {
      const type = baseTypeName(node.childForFieldName('type'))
      const body = node.childForFieldName('body')
      if (type === undefined || body === null) continue
      for (const member of body.namedChildren) {
        const memberName = member === null ? undefined : nameOf(member)
        if (member !== null && memberName !== undefined && PUBLIC_MEMBERS.has(member.type))
          if (isPublic(member))
            items.push({
              symbol: `${prefix}${type}::${memberName}`,
              row: member.startPosition.row,
              isTest: false,
              documented: isDocumented(member),
            })
      }
    } else if (name !== undefined && PUBLIC_ITEMS.has(node.type)) {
      const isTest = node.type === 'function_item' && attributesOfNode.some(isTestAttribute)
      if (isTest || isPublic(node)) {
        items.push({ symbol: `${prefix}${name}`, row, isTest, documented: isDocumented(node) })
        members.push(...membersOf(node, `${prefix}${name}`))
      }
    }
  }
  return { items, members }
}

/** What the Rust `source` holds that a covering chapter should show, in file order. */
const coverableFile = async (source: string): Promise<Coverable> => {
  const parsed = await parseRust(source)
  try {
    return {
      ...coverableIn(parsed, parsed.root, ''),
      moduleDocumented: innerDocCommentOf(parsed.root) !== '',
    }
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
  const shown = new Set(references.filter((r) => r.shown).map(({ path, row }) => `${path}:${row}`))
  let total = 0
  let tests = 0
  const missing: { path: string; symbol: string }[] = []
  const unshownTests: { path: string; symbol: string }[] = []
  const undocumented: Undocumented[] = []
  for (const { path, items, members, moduleDocumented } of files) {
    if (!moduleDocumented) undocumented.push({ path, symbol: 'self', kind: 'module' })
    for (const { symbol, row, isTest, documented } of items) {
      total++
      if (!named.has(`${path}:${row}`)) missing.push({ path, symbol })
      if (isTest) {
        tests++
        if (!shown.has(`${path}:${row}`)) unshownTests.push({ path, symbol })
      }
      if (!documented) undocumented.push({ path, symbol, kind: isTest ? 'test' : 'item' })
    }
    for (const { symbol, kind, documented } of members)
      if (!documented) undocumented.push({ path, symbol, kind })
  }
  return {
    total,
    referenced: total - missing.length,
    missing,
    undocumented,
    tests,
    unshownTests,
  }
}

const warnings = (entries: readonly { readonly path: string; readonly symbol: string }[]): string =>
  entries.map(({ path, symbol }) => `  WARNING: ${path} ${symbol}\n`).join('')

/**
 * The report as the build prints it: the items not in the book, then a list
 * per kind (modules, items, tests, fields, variants) of those without a doc comment,
 * then the tests not shown.
 */
const formatCoverage = (report: CoverageReport): string => {
  const head = `coverage: ${report.referenced}/${report.total} items`
  let out =
    report.missing.length === 0
      ? `${head}; every covered item is in the book\n`
      : `${head}; ${report.missing.length} not in the book:\n${warnings(report.missing)}`
  for (const kind of ['module', 'item', 'test', 'field', 'variant'] as const) {
    const of = report.undocumented.filter((u) => u.kind === kind)
    if (of.length > 0)
      out += `undocumented ${kind}s: ${of.length} without a doc comment:\n${warnings(of)}`
  }
  const shownTests = report.tests - report.unshownTests.length
  out +=
    report.unshownTests.length === 0
      ? `tests: ${shownTests}/${report.tests} shown; every covered test is in the book\n`
      : `tests: ${shownTests}/${report.tests} shown; ${report.unshownTests.length} not shown by {{#item tests=…}} or {{#code}}:\n${warnings(report.unshownTests)}`
  return out
}

export type {
  Coverable,
  CoverableItem,
  CoverableMember,
  CoverageReport,
  CoveredFile,
  ItemReference,
  Undocumented,
}
export { coverableFile, coverageReport, formatCoverage }
