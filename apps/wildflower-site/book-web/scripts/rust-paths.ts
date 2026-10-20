// How a doc comment's intra-doc link names an item: the module a file is,
// the names its `use` declarations bring in, and the absolute paths
// (`crate::domain::client::Client`) a link's destination can mean from where
// the item sits. Paths here are segment arrays from the crate root, without
// the leading `crate`.
//
//   src/lib.rs, src/main.rs   the crate root: []
//   src/a/mod.rs, src/a.rs    ['a']
//   src/a/b.rs                ['a', 'b']
//   tests/x.rs                the root of its own test crate: []
//
// `#[path]` attributes aren't read.
import { posix } from 'node:path'

import type { Node } from 'web-tree-sitter'

import { parseRust } from './rust-items.ts'

/** A crate a file belongs to, as far as paths inside it go. */
interface RustCrate {
  /** Tells crates apart: the crate's `src/` folder, or a test crate's root file. */
  readonly key: string
  /** The name other crates use for it: the package name with `-` as `_`. */
  readonly name: string
  /** The folder its modules' files are found under, repo-root-relative. */
  readonly rootDir: string
  /** The files the crate root may be, repo-root-relative, in the order Cargo tries them. */
  readonly rootFiles: readonly string[]
}

/** A Rust file: its crate, and the module it is in that crate. */
interface RustFile {
  readonly crate: RustCrate
  readonly module: readonly string[]
}

/**
 * The crate and module of `path` (repo-root-relative), in the package at
 * `packageDir` named `packageName`. A file under `src/` is a module of the
 * library or binary crate; one directly under another folder (`tests/`,
 * `benches/`) is a crate root of its own, and those below it its modules.
 */
const rustFileOf = (packageDir: string, packageName: string, path: string): RustFile => {
  const name = packageName.replaceAll('-', '_')
  const inPackage = posix.relative(packageDir, path)
  const [folder = '', ...below] = inPackage.split('/')
  const src = folder === 'src'
  const rootDir = below.length === 0 ? packageDir : posix.join(packageDir, folder)
  const isOwnRoot = !src && below.length <= 1
  const crate: RustCrate = src
    ? {
        key: rootDir,
        name,
        rootDir,
        rootFiles: [posix.join(rootDir, 'lib.rs'), posix.join(rootDir, 'main.rs')],
      }
    : { key: isOwnRoot ? path : rootDir, name, rootDir, rootFiles: isOwnRoot ? [path] : [] }
  if (crate.rootFiles.includes(path)) return { crate, module: [] }
  const segments = posix.relative(rootDir, path).replace(/\.rs$/, '').split('/')
  return { crate, module: segments.at(-1) === 'mod' ? segments.slice(0, -1) : segments }
}

/**
 * A symbol as a path from its file's module: `<Type as Trait>::member`
 * becomes `Type::member`, the path rustdoc would name it by.
 */
const symbolSegments = (symbol: string): readonly string[] => {
  const qualified = /^<\s*([A-Za-z_]\w*)\s+as\s+[A-Za-z_][\w:]*\s*>::(.+)$/.exec(symbol)
  return (qualified ? `${qualified[1]}::${qualified[2]}` : symbol).split('::')
}

/** Modules are snake_case and types CamelCase, which is all a symbol says of either. */
const isModuleName = (segment: string): boolean => /^[a-z_]/.test(segment)

/** Each candidate file holding the item at an absolute path, and its symbol in that file. */
const filesFor = (
  crate: RustCrate,
  path: readonly string[]
): readonly { readonly file: string; readonly symbol: string }[] => {
  const found: { file: string; symbol: string }[] = []
  for (let split = path.length - 1; split >= 0; split--) {
    const symbol = path.slice(split).join('::')
    const modules = path.slice(0, split)
    const files =
      split === 0
        ? crate.rootFiles
        : [
            `${posix.join(crate.rootDir, ...modules)}.rs`,
            posix.join(crate.rootDir, ...modules, 'mod.rs'),
          ]
    files.forEach((file) => found.push({ file, symbol }))
  }
  return found
}

/** One name a `use` brings in, and the path it stands for, as written. */
interface UseName {
  readonly name: string
  readonly path: readonly string[]
}

/** Splits `text` on `separator` where no brace is open. */
const splitTopLevel = (text: string, separator: string): readonly string[] => {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const char of text) {
    if (char === '{') depth++
    if (char === '}') depth--
    if (char === separator && depth === 0) {
      parts.push(current)
      current = ''
    } else current += char
  }
  parts.push(current)
  return parts
}

/**
 * The names a `use` tree (`a::b::{C, d::E as F, self}`, without `use` and
 * `;`) brings in. Globs bring in nothing nameable, and `as _` nothing at all.
 */
const namesInUseTree = (tree: string, prefix: readonly string[] = []): readonly UseName[] => {
  const text = tree.trim()
  const brace = text.indexOf('{')
  if (brace >= 0 && text.endsWith('}')) {
    const head = text.slice(0, brace).replace(/\s+/g, '').replace(/::$/, '')
    const base = head === '' ? prefix : [...prefix, ...head.split('::')]
    return splitTopLevel(text.slice(brace + 1, -1), ',')
      .filter((part) => part.trim() !== '')
      .flatMap((part) => namesInUseTree(part, base))
  }
  const aliased = /^([\s\S]*?)\s+as\s+([A-Za-z_]\w*)$/.exec(text)
  const pathText = (aliased?.[1] ?? text).replace(/\s+/g, '')
  const alias = aliased?.[2]
  const path = [...prefix, ...pathText.split('::')].filter((segment) => segment !== '')
  if (path.at(-1) === '*' || alias === '_') return []
  if (path.at(-1) === 'self') {
    const module = path.slice(0, -1)
    return module.length === 0 ? [] : [{ name: alias ?? module.at(-1)!, path: module }]
  }
  return [{ name: alias ?? path.at(-1)!, path }]
}

/**
 * The names each inline module of a file brings in with `use`, keyed by the
 * inline modules' path within the file (`''` for the file, `'tests'`).
 */
type FileImports = ReadonlyMap<string, readonly UseName[]>

const fileImports = async (source: string): Promise<FileImports> => {
  const parsed = await parseRust(source)
  try {
    const imports = new Map<string, UseName[]>()
    const walk = (scope: Node, inline: readonly string[]): void => {
      for (const node of scope.namedChildren) {
        if (node === null) continue
        if (node.type === 'use_declaration') {
          const argument = node.childForFieldName('argument')
          if (argument === null) continue
          const key = inline.join('::')
          imports.set(key, [...(imports.get(key) ?? []), ...namesInUseTree(argument.text)])
        } else if (node.type === 'mod_item') {
          const body = node.childForFieldName('body')
          const name = node.childForFieldName('name')?.text
          if (body !== null && name !== undefined) walk(body, [...inline, name])
        }
      }
    }
    walk(parsed.root, [])
    return imports
  } finally {
    parsed.delete()
  }
}

/** Where an item sits, for reading the paths in its doc comment. */
interface PathScope {
  readonly file: RustFile
  /** The item's symbol in its file, as a directive names it. */
  readonly symbol: string
  readonly imports: FileImports
}

/** The module the item is declared in: its file's, and any inline modules the symbol names. */
const moduleOfItem = (scope: PathScope): readonly string[] => {
  const segments = symbolSegments(scope.symbol)
  const inline: string[] = []
  for (const segment of segments.slice(0, -1)) {
    if (!isModuleName(segment)) break
    inline.push(segment)
  }
  return [...scope.file.module, ...inline]
}

/** The type `Self` means at the item: its impl's type, or the item itself when a type. */
const selfTypeOf = (scope: PathScope): readonly string[] | undefined => {
  const module = moduleOfItem(scope)
  const rest = symbolSegments(scope.symbol).slice(module.length - scope.file.module.length)
  if (rest.length >= 2) return [...module, ...rest.slice(0, -1)]
  const [only] = rest
  return only !== undefined && !isModuleName(only) ? [...module, only] : undefined
}

/** `path` (as a `use` or a link writes it) from `module`, if it is written from the crate root, `self` or `super`. */
const absolutePath = (
  crate: RustCrate,
  module: readonly string[],
  path: readonly string[]
): readonly string[] | undefined => {
  const [first, ...rest] = path
  if (first === 'crate' || first === crate.name) return rest
  if (first === 'self') return [...module, ...rest]
  if (first === 'super') {
    let at = [...module]
    let remaining: readonly string[] = path
    while (remaining[0] === 'super') {
      if (at.length === 0) return undefined
      at = at.slice(0, -1)
      remaining = remaining.slice(1)
    }
    return [...at, ...remaining]
  }
  return undefined
}

/** How a link's destination reads from an item. */
interface LinkPaths {
  /** The absolute paths it may name, most likely first. */
  readonly candidates: readonly (readonly string[])[]
  /** It is a bare name found no other way, which a unique item of that name may answer. */
  readonly bare: readonly string[] | undefined
}

/**
 * The absolute paths an intra-doc link's destination (`Self::y`,
 * `crate::a::B`, `B`, `super::c`, an imported name) may name from the item at
 * `scope`. A disambiguator (`fn@`, `struct@`) and a trailing `()` or `!` are
 * dropped. Paths outside the crate (`std::…`) name nothing.
 */
const linkPaths = (destination: string, scope: PathScope): LinkPaths => {
  const cleaned = destination
    .trim()
    .replace(/^[a-z]+@/, '')
    .replace(/(\(\)|!)$/, '')
  const path = cleaned.split('::')
  const [first = '', ...rest] = path
  const module = moduleOfItem(scope)
  const { crate } = scope.file
  const fromRoot = absolutePath(crate, module, path)
  if (fromRoot !== undefined) return { candidates: [fromRoot], bare: undefined }
  if (first === 'Self') {
    const selfType = selfTypeOf(scope)
    return { candidates: selfType ? [[...selfType, ...rest]] : [], bare: undefined }
  }
  const inline = module.slice(scope.file.module.length)
  for (let depth = inline.length; depth >= 0; depth--) {
    const inModule = [...scope.file.module, ...inline.slice(0, depth)]
    const named = scope.imports
      .get(inline.slice(0, depth).join('::'))
      ?.find((u) => u.name === first)
    if (named === undefined) continue
    const target = absolutePath(crate, inModule, named.path) ??
      // A 2018-edition path from the module itself: `use child::Item`.
      [...inModule, ...named.path]
    return { candidates: [[...target, ...rest]], bare: undefined }
  }
  const candidates = [[...module, ...path]]
  if (module.length !== scope.file.module.length) candidates.push([...scope.file.module, ...path])
  return { candidates, bare: path }
}

export type { FileImports, LinkPaths, PathScope, RustCrate, RustFile, UseName }
export {
  absolutePath,
  fileImports,
  filesFor,
  linkPaths,
  moduleOfItem,
  rustFileOf,
  symbolSegments,
  namesInUseTree,
}
