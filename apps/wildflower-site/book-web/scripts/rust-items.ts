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
//
// A `proptest! { … }` block's functions count as items of the scope the block
// is in, so a property test in `mod tests` is `tests::name`, as a `#[test]` is.
import { createRequire } from 'node:module'

import { Language, Parser, type Node, type Tree } from 'web-tree-sitter'

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

/** Macros whose bodies hold items: `proptest! { #[test] fn name(x in 0..9) { … } }`. */
const ITEM_MACROS: ReadonlySet<string> = new Set(['proptest'])

/** The body of a `proptest! { … }` (or `proptest::proptest! { … }`), if `node` is one. */
const itemMacroBody = (node: Node): Node | undefined => {
  const invocation =
    node.type === 'expression_statement' ? (node.namedChildren[0] ?? undefined) : node
  if (invocation?.type !== 'macro_invocation') return undefined
  const name = invocation.childForFieldName('macro')?.text.split('::').at(-1)?.trim()
  if (name === undefined || !ITEM_MACROS.has(name)) return undefined
  return invocation.namedChildren.find((n) => n?.type === 'token_tree') ?? undefined
}

/**
 * A parsed Rust file. tree-sitter reads a macro's body as tokens, so each
 * item-holding macro's body is parsed again as items, from a copy of the file
 * with everything outside the body blanked: its nodes keep the file's rows
 * and columns. The trees live in the WebAssembly heap until `delete`.
 */
interface ParsedRust {
  readonly root: Node
  /** The items directly in a file or a `mod`'s body, those in its `proptest!` blocks in place of the block. */
  readonly itemsIn: (scope: Node) => readonly Node[]
  readonly delete: () => void
}

/** `text` as spaces, its line breaks kept, so what follows keeps its rows and columns. */
const blank = (text: string): string => text.replace(/[^\n]/g, ' ')

/**
 * `body` with each `fn`'s parameter list blanked. A proptest parameter is a
 * pattern `in` a strategy (`(a, b) in (…).prop_filter(…)`), which isn't Rust
 * and can leave the reparsed `fn` inside an error node; with the list blank it
 * parses as `fn name() { … }`, at the same offsets, and an excerpt still
 * reads the parameters from the source.
 */
const blankParameterLists = (body: string): string => {
  let out = ''
  let at = 0
  for (const match of body.matchAll(/\bfn\s+[A-Za-z_]\w*\s*\(/g)) {
    const open = match.index + match[0].length - 1
    if (open < at) continue
    let depth = 0
    let close = open
    for (; close < body.length; close++) {
      if (body[close] === '(') depth++
      else if (body[close] === ')' && --depth === 0) break
    }
    out += body.slice(at, open + 1) + blank(body.slice(open + 1, close))
    at = close
  }
  return out + body.slice(at)
}

const parseRust = async (source: string): Promise<ParsedRust> => {
  const rust = await rustParser()
  const tree = rust.parse(source)
  if (tree === null) throw new ItemNotFound('tree-sitter could not parse the file')
  const bodies = new Map<number, Tree>()
  const bodyItems = (body: Node): readonly Node[] => {
    let parsed = bodies.get(body.id)
    if (parsed === undefined) {
      const start = body.startIndex + 1
      const end = body.endIndex - 1
      const reparsed = rust.parse(
        blank(source.slice(0, start)) +
          blankParameterLists(source.slice(start, end)) +
          blank(source.slice(end))
      )
      if (reparsed === null) return []
      parsed = reparsed
      bodies.set(body.id, parsed)
    }
    return parsed.rootNode.namedChildren.filter((n) => n !== null)
  }
  return {
    root: tree.rootNode,
    itemsIn: (scope) =>
      scope.namedChildren.flatMap((n) => {
        if (n === null) return []
        const body = itemMacroBody(n)
        return body === undefined ? [n] : bodyItems(body)
      }),
    delete: () => {
      bodies.forEach((body) => body.delete())
      tree.delete()
    },
  }
}

type ItemsIn = ParsedRust['itemsIn']

const modBody = (mod: Node): Node | null => mod.childForFieldName('body')

const membersOf = (block: Node, name: string): readonly Node[] => {
  const body = block.childForFieldName('body')
  if (body === null) return []
  return body.namedChildren
    .filter((n): n is Node => n !== null)
    .filter((n) => MEMBER_ITEMS.has(n.type) && nameOf(n) === name)
}

/** The `impl` blocks in `scope` for `type`, optionally only those of `trait`. */
const implsFor = (itemsIn: ItemsIn, scope: Node, type: string, trait?: string): readonly Node[] =>
  itemsIn(scope).filter(
    (n) =>
      n.type === 'impl_item' &&
      baseTypeName(n.childForFieldName('type')) === type &&
      (trait === undefined || baseTypeName(n.childForFieldName('trait')) === trait)
  )

const QUALIFIED_SELF = /^<\s*([A-Za-z_][\w]*)\s+as\s+([A-Za-z_][\w:]*)\s*>::([A-Za-z_]\w*)$/

const resolve = (itemsIn: ItemsIn, scope: Node, segments: readonly string[]): readonly Node[] => {
  const [first, ...rest] = segments
  if (first === undefined) return []
  if (rest.length === 0)
    return itemsIn(scope).filter((n) => NAMED_ITEMS.has(n.type) && nameOf(n) === first)
  const inModules = itemsIn(scope)
    .filter((n) => n.type === 'mod_item' && nameOf(n) === first)
    .flatMap((mod) => {
      const body = modBody(mod)
      return body === null ? [] : resolve(itemsIn, body, rest)
    })
  const [member, ...deeper] = rest
  if (member === undefined || deeper.length > 0) return inModules
  const inImpls = implsFor(itemsIn, scope, first).flatMap((impl) => membersOf(impl, member))
  const inTraits = itemsIn(scope)
    .filter((n) => n.type === 'trait_item' && nameOf(n) === first)
    .flatMap((trait) => membersOf(trait, member))
  return [...inModules, ...inImpls, ...inTraits]
}

/** The node's last row, not counting a trailing newline it ends with. */
const lastRow = (node: Node): number => {
  const end = node.endPosition
  return end.column === 0 && end.row > node.startPosition.row ? end.row - 1 : end.row
}

/** The text on `row` outside `[startColumn, endColumn)` is blank. */
const aloneOnRows = (lines: readonly string[], node: Node): boolean => {
  const start = node.startPosition
  const end = node.endPosition
  const before = lines[start.row].slice(0, start.column)
  const after = lastRow(node) === end.row ? lines[end.row].slice(end.column) : ''
  return before.trim() === '' && after.trim() === ''
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

// Outer doc comments: `///` lines and `/** */` blocks, not `//!` or `/*!`.
const isOuterDocComment = (node: Node): boolean =>
  (node.type === 'line_comment' && /^\/\/\/(?!\/)/.test(node.text)) ||
  (node.type === 'block_comment' && /^\/\*\*(?![*/])/.test(node.text))

/**
 * The outer doc comments on `item`, in source order: the `///` and block doc comment
 * siblings before it, past its attributes and ordinary comments, up to the
 * previous item.
 */
const outerDocNodes = (item: Node): readonly Node[] => {
  const docs: Node[] = []
  for (let at = item.previousNamedSibling; at !== null; at = at.previousNamedSibling) {
    if (isOuterDocComment(at)) docs.unshift(at)
    else if (!isAttribute(at) && at.type !== 'line_comment' && at.type !== 'block_comment') break
  }
  return docs
}

/** The lines of a doc comment's node, without its markers. */
const docLinesOf = (node: Node): readonly string[] => {
  const text = node.text.replace(/\n$/, '')
  if (node.type === 'line_comment') return [text.replace(/^\/\/\//, '')]
  return text
    .replace(/^\/\*\*/, '')
    .replace(/\*\/$/, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\* ?/, ''))
}

/**
 * `item`'s outer doc comment as Markdown, as rustdoc reads it: the markers
 * gone and the lines' common indentation removed. Empty when it has none.
 */
const docCommentOf = (item: Node): string => {
  const lines = outerDocNodes(item).flatMap(docLinesOf)
  const indents = lines
    .filter((line) => line.trim() !== '')
    .map((line) => line.length - line.trimStart().length)
  const margin = indents.length === 0 ? 0 : Math.min(...indents)
  return lines
    .map((line) => line.slice(margin).trimEnd())
    .join('\n')
    .trim()
}

/** What a Rust item is, beyond where it sits: its node kind and its doc comment. */
interface RustItem extends LocatedItem {
  /** The tree-sitter node type: `struct_item`, `function_item`, … */
  readonly kind: string
  /** Its outer doc comment as Markdown (`docCommentOf`); empty when it has none. */
  readonly docComment: string
}

const locate = (lines: readonly string[], item: Node): RustItem => {
  const docRows = new Set<number>()
  const attributeRows = new Set<number>()
  // The item itself, so a `from=` on its first line takes all of it.
  const statementEnds = new Map<string, number>([
    [`${item.startPosition.row}:${item.startPosition.column}`, lastRow(item)],
  ])
  for (const node of descendants(item)) {
    if (isDocComment(node) && aloneOnRows(lines, node)) rowsOf(node).forEach((r) => docRows.add(r))
    if (isAttribute(node) && aloneOnRows(lines, node))
      rowsOf(node).forEach((r) => attributeRows.add(r))
    const { row, column } = node.startPosition
    const key = `${row}:${column}`
    statementEnds.set(key, Math.max(statementEnds.get(key) ?? row, lastRow(node)))
  }
  return {
    kind: item.type,
    docComment: docCommentOf(item),
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
const locateRustItem = async (source: string, symbol: string): Promise<RustItem> => {
  const parsed = await parseRust(source)
  // What `locate` returns holds rows, not nodes, so the trees can go.
  try {
    const { root, itemsIn } = parsed
    const qualified = QUALIFIED_SELF.exec(symbol)
    const matches = qualified
      ? implsFor(itemsIn, root, qualified[1], qualified[2].split('::').at(-1)).flatMap((impl) =>
          membersOf(impl, qualified[3])
        )
      : resolve(itemsIn, root, symbol.split('::'))
    const [only, ...others] = matches
    if (only === undefined) throw new ItemNotFound(`no Rust item named ${symbol}`)
    if (others.length > 0)
      throw new ItemNotFound(
        `${symbol} is ambiguous: it names the items at lines ${matches.map((n) => n.startPosition.row + 1).join(', ')}; qualify it, as <Type as Trait>::member or module::Item`
      )
    return locate(source.split('\n'), only)
  } finally {
    parsed.delete()
  }
}

export type { ParsedRust, RustItem }
export { docCommentOf, locateRustItem, parseRust }
