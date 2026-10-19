// The directives the book's pages write, and what each becomes (README.md,
// "Writing a chapter", is the reference). Paths are repo-root-relative.
//
//   {{#chapter "<path>"}}   a stub in src/: the chapter's whole text
//   {{#code <path> <symbol> [keep-docs] [from="…" [to="…" | through="…"]]…}}
//   {{#code-link <path> <symbol> [from=… …]}}   a link to the lines {{#code}} would show
import { existsSync, readFileSync } from 'node:fs'
import { dirname, extname, join, relative } from 'node:path'

import { parse as parseToml } from 'smol-toml'

import { excerpt, ExcerptError, type Fragment, type LocatedItem } from './excerpt.ts'
import { ItemNotFound } from './item-not-found.ts'
import { locateRustItem } from './rust-items.ts'
import { locateTypeScriptItem } from './typescript-items.ts'

interface CodeDirective {
  readonly kind: 'code' | 'code-link'
  /** The directive as written, for error messages. */
  readonly raw: string
  /** Repo-root-relative. */
  readonly path: string
  readonly symbol: string
  readonly keepDocs: boolean
  readonly fragments: readonly Fragment[]
}

/** A directive the book can't build: bad syntax, a missing file, symbol or fragment text. */
class DirectiveError extends Error {}

/** Where the book links its excerpts. */
interface LinkTargets {
  /** The repository on GitHub, e.g. `https://github.com/wildflowerhealthio/Wildflower`. */
  readonly repositoryUrl: string
  /** The commit the book is built from, which every GitHub link names. */
  readonly commit: string
  /** The code index's root, slash-terminated. */
  readonly codeIndexUrl: string
}

/** Splits a directive's arguments on blanks, keeping `"…"` (with `\"` and `\\`) whole. */
const tokenize = (args: string): readonly string[] => {
  const tokens: string[] = []
  let current = ''
  let inToken = false
  let quoted = false
  for (let i = 0; i < args.length; i++) {
    const char = args[i]
    if (quoted) {
      if (char === '\\' && i + 1 < args.length) current += args[++i]
      else if (char === '"') quoted = false
      else current += char
    } else if (char === '"') {
      quoted = true
      inToken = true
    } else if (/\s/.test(char)) {
      if (inToken) tokens.push(current)
      current = ''
      inToken = false
    } else {
      current += char
      inToken = true
    }
  }
  if (quoted) throw new DirectiveError('an unclosed quote')
  if (inToken) tokens.push(current)
  return tokens
}

const OPTION = /^(?<key>from|to|through)=(?<text>[\s\S]*)$/

const parseDirective = (kind: CodeDirective['kind'], raw: string, args: string): CodeDirective => {
  const [path, symbol, ...options] = tokenize(args)
  if (path === undefined || symbol === undefined)
    throw new DirectiveError(`${raw}: expected a path and a symbol`)
  let keepDocs = false
  const fragments: { from: string; end?: Fragment['end'] }[] = []
  for (const option of options) {
    if (option === 'keep-docs') {
      keepDocs = true
      continue
    }
    const { key, text } = OPTION.exec(option)?.groups ?? {}
    if (text === undefined || (key !== 'from' && key !== 'to' && key !== 'through'))
      throw new DirectiveError(`${raw}: unknown option ${option}`)
    if (text === '') throw new DirectiveError(`${raw}: ${key}= is empty`)
    const last = fragments.at(-1)
    if (key === 'from') fragments.push({ from: text })
    else if (last === undefined || last.end !== undefined)
      throw new DirectiveError(`${raw}: ${key}= must follow its own from=`)
    else last.end = { kind: key, text }
  }
  return { kind, raw, path, symbol, keepDocs, fragments }
}

/** A directive found in a chapter, and where its text sits. */
interface FoundDirective {
  readonly start: number
  readonly end: number
  readonly directive: CodeDirective
}

const OPENING = /\{\{#(code|code-link)\s/g

/** Every directive in `markdown`, in order. */
const findDirectives = (markdown: string): readonly FoundDirective[] => {
  const found: FoundDirective[] = []
  for (const match of markdown.matchAll(OPENING)) {
    const start = match.index
    const argsStart = start + match[0].length
    let quoted = false
    let end = -1
    for (let i = argsStart; i < markdown.length - 1; i++) {
      const char = markdown[i]
      if (quoted && char === '\\') i++
      else if (char === '"') quoted = !quoted
      else if (!quoted && char === '}' && markdown[i + 1] === '}') {
        end = i + 2
        break
      }
    }
    const raw = markdown.slice(start, end < 0 ? markdown.indexOf('\n', start) : end)
    if (end < 0) throw new DirectiveError(`${raw}: no closing }}`)
    const kind = match[1] === 'code-link' ? 'code-link' : 'code'
    found.push({
      start,
      end,
      directive: parseDirective(kind, raw, markdown.slice(argsStart, end - 2)),
    })
  }
  return found
}

/** The string at `keys` in a parsed manifest, if there is one. */
const stringAt = (value: unknown, ...keys: readonly string[]): string | undefined => {
  let at = value
  for (const key of keys) {
    if (typeof at !== 'object' || at === null || !(key in at)) return undefined
    at = Reflect.get(at, key)
  }
  return typeof at === 'string' ? at : undefined
}

/** The package holding `path` (repo-root-relative): its directory and name. */
const owningPackage = (
  repoRoot: string,
  path: string
): { dir: string; name: string } | undefined => {
  for (let dir = dirname(path); dir !== '.' && dir !== '/'; dir = dirname(dir)) {
    const cargo = join(repoRoot, dir, 'Cargo.toml')
    if (existsSync(cargo)) {
      const name = stringAt(parseToml(readFileSync(cargo, 'utf8')), 'package', 'name')
      if (name !== undefined) return { dir, name }
    }
    const npm = join(repoRoot, dir, 'package.json')
    if (existsSync(npm)) {
      const name = stringAt(JSON.parse(readFileSync(npm, 'utf8')), 'name')
      if (name !== undefined) return { dir, name }
    }
  }
  return undefined
}

/**
 * The code index's page for a package: its name without the npm scope or the
 * crates' `wildflowerhealthio-` prefix, as `code-index-web/scripts/extract.ts`
 * names it. (A crate whose name a TypeScript package shares takes `-rust`
 * there; no such pair exists.)
 */
const codeIndexSlug = (packageName: string): string =>
  packageName.replace(/^@[^/]+\//, '').replace(/^wildflowerhealthio-/, '')

const escapeHtml = (text: string): string =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

const FENCE_LANGUAGES: Readonly<Record<string, string>> = {
  '.rs': 'rust',
  '.ts': 'ts',
  '.mts': 'ts',
  '.cts': 'ts',
  '.tsx': 'tsx',
}

const locateItem = async (path: string, source: string, symbol: string): Promise<LocatedItem> =>
  extname(path) === '.rs'
    ? locateRustItem(source, symbol)
    : locateTypeScriptItem(path, source, symbol)

const githubUrl = (
  targets: LinkTargets,
  path: string,
  firstRow: number,
  lastRow: number
): string => {
  const lines = firstRow === lastRow ? `L${firstRow + 1}` : `L${firstRow + 1}-L${lastRow + 1}`
  return `${targets.repositoryUrl}/blob/${targets.commit}/${path.split('/').map(encodeURIComponent).join('/')}#${lines}`
}

/** What `directive` becomes in the chapter's Markdown. */
const renderDirective = async (
  directive: CodeDirective,
  repoRoot: string,
  targets: LinkTargets
): Promise<string> => {
  const language = FENCE_LANGUAGES[extname(directive.path)]
  if (language === undefined)
    throw new DirectiveError(`${directive.raw}: only .rs and .ts files can be excerpted`)
  const file = join(repoRoot, directive.path)
  if (!existsSync(file)) throw new DirectiveError(`${directive.raw}: no file ${directive.path}`)
  const source = readFileSync(file, 'utf8')
  let shown
  try {
    const item = await locateItem(directive.path, source, directive.symbol)
    shown = excerpt(source, item, {
      fragments: directive.fragments,
      keepDocs: directive.keepDocs,
    })
  } catch (error) {
    if (error instanceof ItemNotFound || error instanceof ExcerptError)
      throw new DirectiveError(`${directive.raw}: ${error.message}`)
    throw error
  }
  const github = githubUrl(targets, directive.path, shown.firstRow, shown.lastRow)
  if (directive.kind === 'code-link') return `[\`${directive.symbol}\`](${github})`

  const pkg = owningPackage(repoRoot, directive.path)
  const shownPath = pkg
    ? join(pkg.dir.split('/').at(-1)!, relative(pkg.dir, directive.path))
    : directive.path
  const lines =
    shown.firstRow === shown.lastRow
      ? `line ${shown.firstRow + 1}`
      : `lines ${shown.firstRow + 1}–${shown.lastRow + 1}`
  const links = [
    `<a href="${escapeHtml(github)}"><code>${escapeHtml(shownPath)}</code> ${lines}</a>`,
  ]
  if (pkg)
    links.push(
      `<a href="${escapeHtml(`${targets.codeIndexUrl}${codeIndexSlug(pkg.name)}/`)}">${escapeHtml(codeIndexSlug(pkg.name))} in the code index</a>`
    )
  const fence = '`'.repeat(
    Math.max(3, ...[...shown.text.matchAll(/`+/g)].map((m) => m[0].length + 1))
  )
  return [
    `${fence}${language}`,
    shown.text,
    fence,
    '',
    `<p class="code-source">${links.join(' · ')}</p>`,
  ].join('\n')
}

const CHAPTER = /\{\{#chapter\s+"([^"]+)"\s*\}\}/g

/**
 * `markdown` with each `{{#chapter "<path>"}}` replaced by that file's text,
 * and the paths it included, for naming the chapter in errors. mdbook's own
 * `{{#include}}` can't name a path with spaces, as the docs' file names have,
 * and only warns when the file is missing.
 */
const includeChapters = (
  markdown: string,
  repoRoot: string
): {
  readonly markdown: string
  readonly included: readonly string[]
  readonly errors: readonly string[]
} => {
  const included: string[] = []
  const errors: string[] = []
  const expanded = markdown.replaceAll(CHAPTER, (raw, path: string) => {
    const file = join(repoRoot, path)
    if (!existsSync(file)) {
      errors.push(`${raw}: no file ${path}`)
      return ''
    }
    included.push(path)
    return readFileSync(file, 'utf8')
  })
  return { markdown: expanded, included, errors }
}

/** A chapter with its directives expanded, and the ones that failed. */
interface Expanded {
  readonly markdown: string
  /** One message per directive that failed, naming it; empty when all built. */
  readonly errors: readonly string[]
}

/** `markdown` with every directive replaced by what it renders to. */
const expandDirectives = async (
  markdown: string,
  repoRoot: string,
  targets: LinkTargets
): Promise<Expanded> => {
  let found
  try {
    found = findDirectives(markdown)
  } catch (error) {
    if (error instanceof DirectiveError) return { markdown, errors: [error.message] }
    throw error
  }
  const rendered = await Promise.all(
    found.map(({ directive }) =>
      renderDirective(directive, repoRoot, targets).then(
        (text) => ({ text, error: undefined }),
        (error: unknown) => {
          if (!(error instanceof DirectiveError)) throw error
          return { text: '', error: error.message }
        }
      )
    )
  )
  let out = ''
  let at = 0
  found.forEach(({ start, end }, index) => {
    out += markdown.slice(at, start) + rendered[index].text
    at = end
  })
  return {
    markdown: out + markdown.slice(at),
    errors: rendered.flatMap(({ error }) => (error === undefined ? [] : [error])),
  }
}

export type { CodeDirective, Expanded, FoundDirective, LinkTargets }
export {
  DirectiveError,
  codeIndexSlug,
  expandDirectives,
  findDirectives,
  includeChapters,
  renderDirective,
}
