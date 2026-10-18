// TypeScript packages, from the TypeScript checker. Every identifier is
// resolved to its declaration, through aliases, so a namespace-module access
// like `Client.Schema` reaches the `ClientSchema` it re-exports, and an import
// through a package's `exports` reaches the source file via the `source`
// condition. Each package's program is built once; a use it makes counts for
// whichever package declares what it reaches.
import { existsSync } from 'node:fs'
import { join, relative } from 'node:path'

import ts from 'typescript'

import {
  type FileEntry,
  type Item,
  type PackageIndex,
  Uses,
  isTestPath,
  packageName,
  trimDoc,
} from './model.ts'

const cleanJsDoc = (raw: string): string =>
  raw
    .replace(/^\/\*\*\s?/, '')
    .replace(/\*\/$/, '')
    .split('\n')
    .map((l) => l.replace(/^\s*\* ?/, ''))
    .join('\n')
    .trim()

interface Statement {
  readonly name: string
  readonly start: number
  readonly end: number
  readonly node: ts.Statement
}

/** Indexes TypeScript packages with the checker; the result indexes a set of packages together. */
const typescriptIndex = (
  repoRoot: string,
  commit: string
): ((packages: readonly string[]) => PackageIndex[]) => {
  const t = ts

  const programsFor = (pkg: string): ts.Program[] => {
    const config = join(repoRoot, pkg, 'tsconfig.json')
    const out: ts.Program[] = []
    const build = (path: string): void => {
      const parsed = t.getParsedCommandLineOfConfigFile(
        path,
        {},
        { ...t.sys, onUnRecoverableConfigFileDiagnostic: () => {} }
      )
      if (!parsed) return
      if (parsed.fileNames.length)
        out.push(
          t.createProgram({
            rootNames: parsed.fileNames,
            options: { ...parsed.options, noEmit: true },
          })
        )
      for (const ref of parsed.projectReferences ?? []) {
        const p = ref.path.endsWith('.json') ? ref.path : join(ref.path, 'tsconfig.json')
        if (existsSync(p)) build(p)
      }
    }
    if (existsSync(config)) build(config)
    return out
  }

  const sourceFilesOf = (program: ts.Program, pkg: string): ts.SourceFile[] =>
    program.getSourceFiles().filter((sf) => {
      const rel = relative(repoRoot, sf.fileName)
      return rel.startsWith(pkg + '/') && !sf.isDeclarationFile && !rel.includes('node_modules/')
    })

  /** The statements that declare one name of their own. */
  const isNamedStatement = (
    n: ts.Node
  ): n is
    | ts.FunctionDeclaration
    | ts.ClassDeclaration
    | ts.InterfaceDeclaration
    | ts.TypeAliasDeclaration
    | ts.EnumDeclaration
    | ts.ModuleDeclaration =>
    t.isFunctionDeclaration(n) ||
    t.isClassDeclaration(n) ||
    t.isInterfaceDeclaration(n) ||
    t.isTypeAliasDeclaration(n) ||
    t.isEnumDeclaration(n) ||
    t.isModuleDeclaration(n)

  const namesOf = (s: ts.Statement): string[] => {
    if (t.isVariableStatement(s))
      return s.declarationList.declarations.flatMap((d) =>
        t.isIdentifier(d.name) ? [d.name.text] : []
      )
    const n = isNamedStatement(s) ? s.name : undefined
    return n && t.isIdentifier(n) ? [n.text] : []
  }

  const statementsOf = (sf: ts.SourceFile): Statement[] => {
    const out: Statement[] = []
    const line = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line
    for (const s of sf.statements) {
      if (
        t.isImportDeclaration(s) ||
        t.isImportEqualsDeclaration(s) ||
        t.isExportDeclaration(s) ||
        t.isExportAssignment(s)
      )
        continue
      const names = namesOf(s)
      if (names.length)
        out.push({ name: names.join(', '), start: line(s.getStart(sf)), end: line(s.end), node: s })
    }
    return out
  }

  const kindOf = (s: ts.Statement): string => {
    if (t.isFunctionDeclaration(s)) return 'Function'
    if (t.isClassDeclaration(s)) return 'Class'
    if (t.isInterfaceDeclaration(s)) return 'Interface'
    if (t.isTypeAliasDeclaration(s)) return 'Type'
    if (t.isEnumDeclaration(s)) return 'Enum'
    if (t.isModuleDeclaration(s)) return 'Namespace'
    if (t.isVariableStatement(s)) {
      const init = s.declarationList.declarations[0]?.initializer
      if (init && (t.isArrowFunction(init) || t.isFunctionExpression(init))) return 'Function'
      // Effect constructors say what the constant is: `Schema.Struct`, `Context.Tag`, `Layer.effect`…
      let callee: ts.Node | undefined = init
      while (callee && t.isCallExpression(callee)) callee = callee.expression
      if (callee && t.isPropertyAccessExpression(callee) && t.isIdentifier(callee.expression))
        return `${callee.expression.text}.${callee.name.text}`
      return 'Constant'
    }
    return 'Statement'
  }

  const docOf = (node: ts.Node, sf: ts.SourceFile): string => {
    const ranges = t.getLeadingCommentRanges(sf.text, node.getFullStart()) ?? []
    const last = ranges.filter((r) => sf.text.startsWith('/**', r.pos)).at(-1)
    return last ? cleanJsDoc(sf.text.slice(last.pos, last.end)) : ''
  }

  // The header is the first `/** */` block when it stands apart from the
  // first statement: an import follows it, or a second doc block does.
  const headerOf = (sf: ts.SourceFile): string => {
    const first = sf.statements[0]
    if (!first) return ''
    const ranges = (t.getLeadingCommentRanges(sf.text, first.getFullStart()) ?? []).filter((r) =>
      sf.text.startsWith('/**', r.pos)
    )
    if (ranges.length > 1 || (ranges.length === 1 && t.isImportDeclaration(first)))
      return cleanJsDoc(sf.text.slice(ranges[0].pos, ranges[0].end))
    return ''
  }

  const exportedNamesOf = (sf: ts.SourceFile): Set<string> => {
    const out = new Set<string>()
    for (const s of sf.statements) {
      if (
        t.isExportDeclaration(s) &&
        !s.moduleSpecifier &&
        s.exportClause &&
        t.isNamedExports(s.exportClause)
      )
        for (const el of s.exportClause.elements) out.add((el.propertyName ?? el.name).getText(sf))
      const mods = t.canHaveModifiers(s) ? t.getModifiers(s) : undefined
      if (mods?.some((m) => m.kind === t.SyntaxKind.ExportKeyword))
        namesOf(s).forEach((n) => out.add(n))
    }
    return out
  }

  /** Identifiers whose references aren't uses: imports, exports, and a declaration's own name. */
  const ignorable = (id: ts.Identifier): boolean => {
    for (let p: ts.Node | undefined = id.parent; p; p = p.parent) {
      if (
        t.isImportDeclaration(p) ||
        t.isImportEqualsDeclaration(p) ||
        t.isExportDeclaration(p) ||
        t.isExportSpecifier(p)
      )
        return true
      if (t.isStatement(p) || t.isSourceFile(p)) break
    }
    const parent = id.parent
    return (t.isVariableDeclaration(parent) || isNamedStatement(parent)) && parent.name === id
  }

  return (packages: readonly string[]): PackageIndex[] => {
    // The longest package directory holding a path wins: packages nest.
    const byDepth = packages.toSorted((x, y) => y.length - x.length)
    const packageOf = (path: string): string | undefined =>
      byDepth.find((p) => path.startsWith(p + '/'))

    interface PackageState {
      readonly files: Map<string, FileEntry>
      readonly items: Map<string, Item>
      readonly uses: Uses
    }
    const states = new Map<string, PackageState>(
      packages.map((p) => [p, { files: new Map(), items: new Map(), uses: new Uses() }])
    )

    // Repo-relative path → its statements' line ranges and item ids, made the
    // first time any program meets the file.
    const fileItems = new Map<string, { start: number; end: number; id: string }[]>()
    const register = (path: string, pkg: string, sf: ts.SourceFile): void => {
      if (fileItems.has(path)) return
      const { files, items } = states.get(pkg)!
      const rel = relative(pkg, path)
      const fileTest = isTestPath(rel)
      files.set(rel, {
        path: rel,
        doc: trimDoc(headerOf(sf)),
        lines: sf.getLineAndCharacterOfPosition(sf.end).line + 1,
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
      const exported = exportedNamesOf(sf)
      const list: { start: number; end: number; id: string }[] = []
      const byName = new Map<string, string>()
      for (const st of statementsOf(sf)) {
        // A schema and its type share a name (`const Client = …; type Client = …`): one item.
        const twin = byName.get(st.name)
        if (twin) {
          const it = items.get(twin)!
          items.set(twin, {
            ...it,
            kind: `${it.kind} + ${kindOf(st.node)}`,
            line: Math.min(it.line, st.start + 1),
            endLine: Math.max(it.endLine, st.end + 1),
            doc: it.doc || trimDoc(docOf(st.node, sf)),
          })
          list.push({ start: st.start, end: st.end, id: twin })
          continue
        }
        let id = `${rel}#${st.name}`
        for (let k = 2; items.has(id); k++) id = `${rel}#${st.name}~${k}`
        byName.set(st.name, id)
        items.set(id, {
          id,
          file: rel,
          name: st.name,
          kind: kindOf(st.node),
          line: st.start + 1,
          endLine: st.end + 1,
          doc: trimDoc(docOf(st.node, sf)),
          signature: '',
          exported: st.name.split(', ').some((n) => exported.has(n)),
          test: fileTest,
        })
        list.push({ start: st.start, end: st.end, id })
      }
      fileItems.set(path, list)
    }
    const itemAt = (path: string, line: number): string | undefined =>
      fileItems.get(path)?.find((s) => line >= s.start && line <= s.end)?.id

    // Each package's programs are built once, scanned, and let go. A use
    // counts for the package that declares what it reaches: internally (or as
    // a test use) when that's the scanned package, externally otherwise.
    for (const pkg of packages) {
      const started = Date.now()
      for (const program of programsFor(pkg)) {
        const checker = program.getTypeChecker()
        const own = sourceFilesOf(program, pkg).filter(
          (sf) => packageOf(relative(repoRoot, sf.fileName)) === pkg
        )
        for (const sf of own) register(relative(repoRoot, sf.fileName), pkg, sf)
        for (const sf of own) {
          const path = relative(repoRoot, sf.fileName)
          const rel = relative(pkg, path)
          const { items, uses } = states.get(pkg)!
          const record = (id: ts.Identifier): void => {
            let sym = checker.getSymbolAtLocation(id)
            if (!sym) return
            if (sym.flags & t.SymbolFlags.Alias) {
              try {
                sym = checker.getAliasedSymbol(sym)
              } catch {
                return
              }
            }
            const decl = sym.declarations?.[0]
            if (!decl || t.isSourceFile(decl)) return
            const declSf = decl.getSourceFile()
            const declPath = relative(repoRoot, declSf.fileName)
            const declPkg = packageOf(declPath)
            if (!declPkg || declSf.isDeclarationFile || declPath.includes('node_modules/')) return
            register(declPath, declPkg, declSf)
            const target = itemAt(
              declPath,
              declSf.getLineAndCharacterOfPosition(decl.getStart()).line
            )
            if (!target) return
            if (declPkg !== pkg) return states.get(declPkg)!.uses.externalUse(target, pkg)
            const from =
              itemAt(path, sf.getLineAndCharacterOfPosition(id.getStart(sf)).line) ?? `${rel}#`
            if (from === target) return
            if (items.get(from)?.test) uses.testUse(target)
            else uses.internalUse(from, target)
          }
          const visit = (node: ts.Node): void => {
            if (t.isIdentifier(node) && !ignorable(node)) record(node)
            node.forEachChild(visit)
          }
          visit(sf)
        }
      }
      process.stderr.write(`  scanned ${pkg} (${Date.now() - started} ms)\n`)
    }

    return packages.map((pkg) => {
      const { files, items, uses } = states.get(pkg)!
      const edges = uses.edges()
      const touched = new Set(edges.flatMap((e) => [e.from, e.to]))
      for (const [id, it] of items) if (it.kind === 'Module' && !touched.has(id)) items.delete(id)
      return {
        package: {
          name: packageName(repoRoot, pkg),
          path: pkg,
          language: 'typescript',
          commit,
          repository: 'wildflowerhealthio/Wildflower',
        },
        files: [...files.values()].toSorted((a, b) => a.path.localeCompare(b.path)),
        items: [...items.values()],
        edges,
        testUses: Object.fromEntries(uses.testUses),
        externalUses: Object.fromEntries(
          [...uses.externalUses].map(([k, m]) => [k, Object.fromEntries(m)])
        ),
      }
    })
  }
}

export { typescriptIndex }
