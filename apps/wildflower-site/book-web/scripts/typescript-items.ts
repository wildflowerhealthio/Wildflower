// Finds a TypeScript item by name with the TypeScript parser.
//
//   Name          a function, class, interface, type alias, enum, namespace
//                 or variable statement at the top of the file
//   Name.member   a member of that class or interface, or a declaration in
//                 that namespace
//
// A type alias derived from the value of its name (`type X = typeof X.Type`)
// gives way to that value.
import ts from 'typescript'

import type { LocatedItem } from './excerpt.ts'
import { ItemNotFound } from './item-not-found.ts'

const declaredName = (node: ts.Node): string | undefined => {
  if (ts.isVariableStatement(node)) {
    const [declaration] = node.declarationList.declarations
    return declaration && ts.isIdentifier(declaration.name) ? declaration.name.text : undefined
  }
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isModuleDeclaration(node)
  ) {
    return node.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
      ? node.name.text
      : undefined
  }
  return undefined
}

const memberName = (member: ts.ClassElement | ts.TypeElement): string | undefined => {
  const name = member.name
  return name && (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name))
    ? name.text
    : undefined
}

const statementsIn = (scope: ts.SourceFile | ts.ModuleDeclaration): readonly ts.Node[] => {
  if (ts.isSourceFile(scope)) return scope.statements
  const body = scope.body
  return body && ts.isModuleBlock(body) ? body.statements : []
}

/** The leftmost name of `a.b.c`. */
const leftmostName = (name: ts.EntityName): string =>
  ts.isIdentifier(name) ? name.text : leftmostName(name.left)

/** `node` holds a `typeof name` (or `typeof name.…`) anywhere in it. */
const queriesValue = (node: ts.Node, name: string): boolean =>
  (ts.isTypeQueryNode(node) && leftmostName(node.exprName) === name) ||
  (ts.forEachChild(node, (child) => queriesValue(child, name) || undefined) ?? false)

/**
 * The declarations `name` names in `scope`, leaving out a type alias derived
 * from the value beside it (`type X = typeof X.Type`, the schema convention),
 * which only restates that value's type: `X` means the value.
 */
const declarationsNamed = (
  scope: ts.SourceFile | ts.ModuleDeclaration,
  name: string
): readonly ts.Node[] => {
  const named = statementsIn(scope).filter((node) => declaredName(node) === name)
  const withoutDerived = named.filter(
    (node) => !(ts.isTypeAliasDeclaration(node) && queriesValue(node.type, name))
  )
  return withoutDerived.length > 0 ? withoutDerived : named
}

const resolve = (
  scope: ts.SourceFile | ts.ModuleDeclaration,
  segments: readonly string[]
): readonly ts.Node[] => {
  const [first, ...rest] = segments
  if (first === undefined) return []
  const named = declarationsNamed(scope, first)
  if (rest.length === 0) return named
  return named.flatMap((node) => {
    if (ts.isModuleDeclaration(node)) return resolve(node, rest)
    if (rest.length === 1 && (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)))
      return node.members.filter((member) => memberName(member) === rest[0])
    return []
  })
}

const descendants = function* (node: ts.Node): Generator<ts.Node> {
  const children: ts.Node[] = []
  ts.forEachChild(node, (child) => {
    children.push(child)
  })
  for (const child of children) {
    yield child
    yield* descendants(child)
  }
}

const locate = (file: ts.SourceFile, item: ts.Node): LocatedItem => {
  const source = file.text
  const lines = source.split('\n')
  const rowOf = (pos: number): number => file.getLineAndCharacterOfPosition(pos).line
  const aloneRows = (start: number, end: number): readonly number[] => {
    const first = file.getLineAndCharacterOfPosition(start)
    const last = file.getLineAndCharacterOfPosition(end)
    const before = lines[first.line].slice(0, first.character)
    const after = lines[last.line].slice(last.character)
    if (before.trim() !== '' || after.trim() !== '') return []
    return Array.from({ length: last.line - first.line + 1 }, (_, i) => first.line + i)
  }
  const itemStart = item.getStart(file)
  const docRows = new Set<number>()
  const attributeRows = new Set<number>()
  // The item itself, so a `from=` on its first line takes all of it.
  const statementEnds = new Map<number, number>([[itemStart, rowOf(item.end)]])
  for (const node of descendants(item)) {
    for (const range of ts.getLeadingCommentRanges(source, node.pos) ?? []) {
      if (range.pos >= itemStart && source.startsWith('/**', range.pos))
        aloneRows(range.pos, range.end).forEach((row) => docRows.add(row))
    }
    if (ts.isDecorator(node))
      aloneRows(node.getStart(file), node.end).forEach((row) => attributeRows.add(row))
    const start = node.getStart(file)
    statementEnds.set(start, Math.max(statementEnds.get(start) ?? 0, rowOf(node.end)))
  }
  return {
    startRow: rowOf(itemStart),
    endRow: rowOf(item.end),
    docRows,
    attributeRows,
    statementEndRow: (row) => {
      const line = lines[row] ?? ''
      const start = file.getPositionOfLineAndCharacter(row, line.length - line.trimStart().length)
      return statementEnds.get(start) ?? row
    },
  }
}

/**
 * The item `symbol` names in the TypeScript `source`.
 *
 * @throws {@link ItemNotFound} when no item or more than one matches.
 */
const locateTypeScriptItem = (fileName: string, source: string, symbol: string): LocatedItem => {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const matches = resolve(file, symbol.split('.'))
  const [only, ...others] = matches
  if (only === undefined) throw new ItemNotFound(`no TypeScript item named ${symbol}`)
  if (others.length > 0)
    throw new ItemNotFound(
      `${symbol} is ambiguous: it names the items at lines ${matches.map((n) => file.getLineAndCharacterOfPosition(n.getStart(file)).line + 1).join(', ')}`
    )
  return locate(file, only)
}

export { locateTypeScriptItem }
