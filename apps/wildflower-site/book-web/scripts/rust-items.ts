// Finds a Rust item by name with tree-sitter's Rust grammar, run as
// WebAssembly, so the book builds without a Rust toolchain.
//
//   Item                      a fn, struct, enum, trait, const, static, type,
//                             union, macro or mod at the top of the file
//   module::Item              the same, inside `mod module { … }`
//   Type::member              a fn, const or type in an `impl Type` or
//                             `impl Trait for Type` block, or a fn in
//                             `trait Type`
//   <Type as Trait>::member   only in `impl Trait for Type`
import { createRequire } from 'node:module'

import { Language, Parser, type Node } from 'web-tree-sitter'

import type { LocatedItem } from './excerpt.ts'
import { ItemNotFound } from './item-not-found.ts'

const require = createRequire(import.meta.url)

/** Loaded once, on first use; directives resolve concurrently. */
let parser: Promise<Parser> | undefined

const loadParser = async (): Promise<Parser> => {
  await Parser.init()
  const rust = await Language.load(require.resolve('tree-sitter-rust/tree-sitter-rust.wasm'))
  const loaded = new Parser()
  loaded.setLanguage(rust)
  return loaded
}

const rustParser = (): Promise<Parser> => (parser ??= loadParser())

/** Items a bare or module-qualified name can name. */
const NAMED_ITEMS: ReadonlySet<string> = new Set([
  'function_item',
  'struct_item',
  'enum_item',
  'trait_item',
  'const_item',
  'static_item',
  'type_item',
  'union_item',
  'macro_definition',
  'mod_item',
])

/** Members of an `impl` or `trait` block. */
const MEMBER_ITEMS: ReadonlySet<string> = new Set([
  'function_item',
  'function_signature_item',
  'const_item',
  'type_item',
  'associated_type',
])

const nameOf = (node: Node): string | undefined => node.childForFieldName('name')?.text

/** `Foo`, `Foo<T>`, `crate::a::Foo<'_>` and `&Foo` all name `Foo`. */
const baseTypeName = (node: Node | null): string | undefined => {
  if (node === null) return undefined
  const withoutGenerics = node.text.replace(/<[\s\S]*$/, '')
  return withoutGenerics
    .replace(/^&\s*(mut\s+)?/, '')
    .split('::')
    .at(-1)
    ?.trim()
}

/** The items directly inside a source file or a `mod`'s body. */
const itemsIn = (scope: Node): readonly Node[] => scope.namedChildren.filter((n) => n !== null)

const modBody = (mod: Node): Node | null => mod.childForFieldName('body')

const membersOf = (block: Node, name: string): readonly Node[] => {
  const body = block.childForFieldName('body')
  if (body === null) return []
  return itemsIn(body).filter((n) => MEMBER_ITEMS.has(n.type) && nameOf(n) === name)
}

/** The `impl` blocks in `scope` for `type`, optionally only those of `trait`. */
const implsFor = (scope: Node, type: string, trait?: string): readonly Node[] =>
  itemsIn(scope).filter(
    (n) =>
      n.type === 'impl_item' &&
      baseTypeName(n.childForFieldName('type')) === type &&
      (trait === undefined || baseTypeName(n.childForFieldName('trait')) === trait)
  )

const QUALIFIED_SELF = /^<\s*([A-Za-z_][\w]*)\s+as\s+([A-Za-z_][\w:]*)\s*>::([A-Za-z_]\w*)$/

const resolve = (scope: Node, segments: readonly string[]): readonly Node[] => {
  const [first, ...rest] = segments
  if (first === undefined) return []
  if (rest.length === 0)
    return itemsIn(scope).filter((n) => NAMED_ITEMS.has(n.type) && nameOf(n) === first)
  const inModules = itemsIn(scope)
    .filter((n) => n.type === 'mod_item' && nameOf(n) === first)
    .flatMap((mod) => {
      const body = modBody(mod)
      return body === null ? [] : resolve(body, rest)
    })
  const [member, ...deeper] = rest
  if (member === undefined || deeper.length > 0) return inModules
  const inImpls = implsFor(scope, first).flatMap((impl) => membersOf(impl, member))
  const inTraits = itemsIn(scope)
    .filter((n) => n.type === 'trait_item' && nameOf(n) === first)
    .flatMap((trait) => membersOf(trait, member))
  return [...inModules, ...inImpls, ...inTraits]
}

/** The text on `row` outside `[startColumn, endColumn)` is blank. */
const aloneOnRows = (lines: readonly string[], node: Node): boolean => {
  const start = node.startPosition
  const end = node.endPosition
  const endRow = end.column === 0 && end.row > start.row ? end.row - 1 : end.row
  const before = lines[start.row].slice(0, start.column)
  const after = endRow === end.row ? lines[endRow].slice(end.column) : ''
  return before.trim() === '' && after.trim() === ''
}

const lastRow = (node: Node): number => {
  const end = node.endPosition
  return end.column === 0 && end.row > node.startPosition.row ? end.row - 1 : end.row
}

const rowsOf = (node: Node): readonly number[] =>
  Array.from(
    { length: lastRow(node) - node.startPosition.row + 1 },
    (_, i) => node.startPosition.row + i
  )

const isDocComment = (node: Node): boolean =>
  (node.type === 'line_comment' && /^\/\/[/!](?!\/)/.test(node.text)) ||
  (node.type === 'block_comment' && /^\/\*[*!](?![*/])/.test(node.text))

const isAttribute = (node: Node): boolean =>
  node.type === 'attribute_item' || node.type === 'inner_attribute_item'

const descendants = function* (node: Node): Generator<Node> {
  for (const child of node.children) {
    if (child === null) continue
    yield child
    yield* descendants(child)
  }
}

const locate = (lines: readonly string[], item: Node): LocatedItem => {
  const docRows = new Set<number>()
  const attributeRows = new Set<number>()
  const statementEnds = new Map<string, number>()
  for (const node of descendants(item)) {
    if (isDocComment(node) && aloneOnRows(lines, node)) rowsOf(node).forEach((r) => docRows.add(r))
    if (isAttribute(node) && aloneOnRows(lines, node))
      rowsOf(node).forEach((r) => attributeRows.add(r))
    const { row, column } = node.startPosition
    const key = `${row}:${column}`
    statementEnds.set(key, Math.max(statementEnds.get(key) ?? row, lastRow(node)))
  }
  return {
    startRow: item.startPosition.row,
    endRow: lastRow(item),
    docRows,
    attributeRows,
    statementEndRow: (row) => {
      const line = lines[row] ?? ''
      return statementEnds.get(`${row}:${line.length - line.trimStart().length}`) ?? row
    },
  }
}

/**
 * The item `symbol` names in the Rust `source`.
 *
 * @throws {@link ItemNotFound} when no item or more than one matches.
 */
const locateRustItem = async (source: string, symbol: string): Promise<LocatedItem> => {
  const tree = (await rustParser()).parse(source)
  if (tree === null) throw new ItemNotFound('tree-sitter could not parse the file')
  const root = tree.rootNode
  const qualified = QUALIFIED_SELF.exec(symbol)
  const matches = qualified
    ? implsFor(root, qualified[1], qualified[2].split('::').at(-1)).flatMap((impl) =>
        membersOf(impl, qualified[3])
      )
    : resolve(root, symbol.split('::'))
  const [only, ...others] = matches
  if (only === undefined) throw new ItemNotFound(`no Rust item named ${symbol}`)
  if (others.length > 0)
    throw new ItemNotFound(
      `${symbol} is ambiguous: it names the items at lines ${matches.map((n) => n.startPosition.row + 1).join(', ')}; qualify it, as <Type as Trait>::member or module::Item`
    )
  return locate(source.split('\n'), only)
}

export { locateRustItem }
