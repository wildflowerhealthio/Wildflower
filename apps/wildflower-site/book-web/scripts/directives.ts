// The directives the book's pages write, and what each becomes (README.md,
// "Writing a chapter", is the reference). Paths are repo-root-relative.
//
//   {{#chapter "<path>"}}   a stub in src/: the chapter's whole text
//   {{#code <path> <symbol> [keep-docs] [from="…" [to="…" | through="…"]]…}}
//   {{#code-link <path> <symbol> [from=… …]}}   a link to the lines {{#code}} would show
//   {{#covers <path>}}      a line naming the file a chapter covers (coverage.ts)
//   {{#covered <path> <symbol>…}}   nothing: counts the items as in the book
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, extname, join, posix, relative } from 'node:path'

import { parse as parseToml } from 'smol-toml'

import type { ItemReference } from './coverage.ts'
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

/**
 * `{{#covers <path>}}`, a chapter's claim that it shows the file's items, or
 * `{{#covered <path> <symbol>…}}`, which counts those items as shown without
 * showing them (a getter a table names, say).
 */
interface CoverageDirective {
  readonly kind: 'covers' | 'covered'
  readonly raw: string
  /** Repo-root-relative. */
  readonly path: string
  /** Empty for `covers`. */
  readonly symbols: readonly string[]
}

type Directive = CodeDirective | CoverageDirective

const isCoverageDirective = (directive: Directive): directive is CoverageDirective =>
  directive.kind === 'covers' || directive.kind === 'covered'

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

const parseCoverageDirective = (
  kind: CoverageDirective['kind'],
  raw: string,
  args: string
): CoverageDirective => {
  const [path, ...symbols] = tokenize(args)
  if (path === undefined) throw new DirectiveError(`${raw}: expected a path`)
  if (kind === 'covers' && symbols.length > 0)
    throw new DirectiveError(`${raw}: expected only a path`)
  if (kind === 'covered' && symbols.length === 0)
    throw new DirectiveError(`${raw}: expected a path and at least one symbol`)
  return { kind, raw, path, symbols }
}

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
  readonly directive: Directive
}

const OPENING = /\{\{#(code-link|code|covers|covered)\s/g

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
    if (end < 0) {
      const lineEnd = markdown.indexOf('\n', start)
      throw new DirectiveError(
        `${markdown.slice(start, lineEnd < 0 ? undefined : lineEnd)}: no closing }}`
      )
    }
    const raw = markdown.slice(start, end)
    const args = markdown.slice(argsStart, end - 2)
    const kind = match[1]
    found.push({
      start,
      end,
      directive:
        kind === 'covers' || kind === 'covered'
          ? parseCoverageDirective(kind, raw, args)
          : parseDirective(kind === 'code-link' ? 'code-link' : 'code', raw, args),
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

/** A package holding an excerpted file. */
interface OwningPackage {
  /** Repo-root-relative. */
  readonly dir: string
  readonly name: string
  readonly isCrate: boolean
}

/** The package holding `path` (repo-root-relative). */
const owningPackage = (repoRoot: string, path: string): OwningPackage | undefined => {
  for (let dir = dirname(path); dir !== '.' && dir !== '/'; dir = dirname(dir)) {
    const cargo = join(repoRoot, dir, 'Cargo.toml')
    if (existsSync(cargo)) {
      const name = stringAt(parseToml(readFileSync(cargo, 'utf8')), 'package', 'name')
      if (name !== undefined) return { dir, name, isCrate: true }
    }
    const npm = join(repoRoot, dir, 'package.json')
    if (existsSync(npm)) {
      const name = stringAt(JSON.parse(readFileSync(npm, 'utf8')), 'name')
      if (name !== undefined) return { dir, name, isCrate: false }
    }
  }
  return undefined
}

/**
 * A package's name without the npm scope or the crates' `wildflowerhealthio-`
 * prefix: its page in the code index, unless a crate's collides.
 */
const codeIndexSlug = (packageName: string): string =>
  packageName.replace(/^@[^/]+\//, '').replace(/^wildflowerhealthio-/, '')

/**
 * The slugs the code index's TypeScript packages take, which a crate of the
 * same name gives way to: every tracked `package.json` beside a
 * `tsconfig.json` and not a crate, as `code-index-web/scripts/extract.ts`
 * lists them. Read once per repository root.
 */
const typeScriptSlugsByRoot = new Map<string, ReadonlySet<string>>()
const typeScriptSlugs = (repoRoot: string): ReadonlySet<string> => {
  const known = typeScriptSlugsByRoot.get(repoRoot)
  if (known !== undefined) return known
  const slugs = new Set(
    execFileSync('git', ['-C', repoRoot, 'ls-files', '*package.json'], { encoding: 'utf8' })
      .split('\n')
      .filter((file) => file !== '' && file !== 'package.json' && !file.includes('node_modules'))
      .map(dirname)
      .filter(
        (dir) =>
          existsSync(join(repoRoot, dir, 'tsconfig.json')) &&
          !existsSync(join(repoRoot, dir, 'Cargo.toml'))
      )
      .flatMap((dir) => {
        const name = stringAt(
          JSON.parse(readFileSync(join(repoRoot, dir, 'package.json'), 'utf8')),
          'name'
        )
        return name === undefined ? [] : [codeIndexSlug(name)]
      })
  )
  typeScriptSlugsByRoot.set(repoRoot, slugs)
  return slugs
}

/**
 * `pkg`'s page in the code index, given the slugs its TypeScript packages
 * take: a crate sharing one takes `-rust`.
 */
const codeIndexPage = (pkg: OwningPackage, takenByTypeScript: ReadonlySet<string>): string => {
  const slug = codeIndexSlug(pkg.name)
  return pkg.isCrate && takenByTypeScript.has(slug) ? `${slug}-rust` : slug
}

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

/** A directive's file's source; it must exist. */
const sourceOf = (directive: Directive, repoRoot: string): string => {
  const file = join(repoRoot, directive.path)
  if (!existsSync(file)) throw new DirectiveError(`${directive.raw}: no file ${directive.path}`)
  return readFileSync(file, 'utf8')
}

/** `path` as an excerpt's caption names it: from its package's folder. */
const shownPathOf = (repoRoot: string, path: string): string => {
  const pkg = owningPackage(repoRoot, path)
  return pkg ? join(pkg.dir.split('/').at(-1)!, relative(pkg.dir, path)) : path
}

/** What a directive becomes in the chapter's Markdown, and the items it names. */
interface Rendered {
  readonly text: string
  readonly references: readonly ItemReference[]
}

/** `{{#covers}}` becomes a line linking the file; `{{#covered}}` becomes nothing. */
const renderCoverageDirective = async (
  directive: CoverageDirective,
  repoRoot: string,
  targets: LinkTargets
): Promise<Rendered> => {
  if (extname(directive.path) !== '.rs')
    throw new DirectiveError(`${directive.raw}: only .rs files can be covered`)
  const source = sourceOf(directive, repoRoot)
  if (directive.kind === 'covers') {
    const github = `${targets.repositoryUrl}/blob/${targets.commit}/${directive.path.split('/').map(encodeURIComponent).join('/')}`
    const shownPath = shownPathOf(repoRoot, directive.path)
    return {
      text: `<p class="code-source">Covers <a href="${escapeHtml(github)}"><code>${escapeHtml(shownPath)}</code></a></p>`,
      references: [],
    }
  }
  const references = await Promise.all(
    directive.symbols.map(async (symbol) => {
      try {
        const item = await locateItem(directive.path, source, symbol)
        return { path: directive.path, row: item.startRow }
      } catch (error) {
        if (error instanceof ItemNotFound)
          throw new DirectiveError(`${directive.raw}: ${error.message}`)
        throw error
      }
    })
  )
  return { text: '', references }
}

/** An excerpt (`{{#code}}`) or a link to one (`{{#code-link}}`), and the item it names. */
const renderCodeDirective = async (
  directive: CodeDirective,
  repoRoot: string,
  targets: LinkTargets
): Promise<Rendered> => {
  const language = FENCE_LANGUAGES[extname(directive.path)]
  if (language === undefined)
    throw new DirectiveError(`${directive.raw}: only .rs and .ts files can be excerpted`)
  const source = sourceOf(directive, repoRoot)
  let shown
  let item
  try {
    item = await locateItem(directive.path, source, directive.symbol)
    shown = excerpt(source, item, {
      fragments: directive.fragments,
      keepDocs: directive.keepDocs,
    })
  } catch (error) {
    if (error instanceof ItemNotFound || error instanceof ExcerptError)
      throw new DirectiveError(`${directive.raw}: ${error.message}`)
    throw error
  }
  const references = [{ path: directive.path, row: item.startRow }]
  const github = githubUrl(targets, directive.path, shown.firstRow, shown.lastRow)
  if (directive.kind === 'code-link')
    return { text: `[\`${directive.symbol}\`](${github})`, references }

  const pkg = owningPackage(repoRoot, directive.path)
  const shownPath = shownPathOf(repoRoot, directive.path)
  const lines =
    shown.firstRow === shown.lastRow
      ? `line ${shown.firstRow + 1}`
      : `lines ${shown.firstRow + 1}–${shown.lastRow + 1}`
  const links = [
    `<a href="${escapeHtml(github)}"><code>${escapeHtml(shownPath)}</code> ${lines}</a>`,
  ]
  if (pkg) {
    const page = codeIndexPage(pkg, typeScriptSlugs(repoRoot))
    links.push(
      `<a href="${escapeHtml(`${targets.codeIndexUrl}${page}/`)}">${escapeHtml(page)} in the code index</a>`
    )
  }
  const fence = '`'.repeat(
    Math.max(3, ...[...shown.text.matchAll(/`+/g)].map((m) => m[0].length + 1))
  )
  return {
    text: [
      `${fence}${language}`,
      shown.text,
      fence,
      '',
      `<p class="code-source">${links.join(' · ')}</p>`,
    ].join('\n'),
    references,
  }
}

/** What `directive` becomes in the chapter's Markdown, and the items it names. */
const renderDirective = (
  directive: Directive,
  repoRoot: string,
  targets: LinkTargets
): Promise<Rendered> =>
  isCoverageDirective(directive)
    ? renderCoverageDirective(directive, repoRoot, targets)
    : renderCodeDirective(directive, repoRoot, targets)

const CHAPTER = /\{\{#chapter\s+"([^"]+)"\s*\}\}/g

/** Each chapter's path in `markdown`, a page of src/. */
const chaptersOf = (markdown: string): readonly string[] =>
  [...markdown.matchAll(CHAPTER)].map((match) => match[1])

/** How a chapter's relative links are rewritten for the page that includes it. */
interface ChapterLinks {
  /** The including page, relative to src/ (`authorization-server/domain/grant.md`). */
  readonly page: string
  /** Each chapter's repo-root-relative path → the page of src/ that includes it. */
  readonly pages: ReadonlyMap<string, string>
  readonly targets: LinkTargets
}

/** An inline link's target: `](<with spaces>)` or `](plain)`. */
const LINK = /\]\((<[^>\n]+>|[^)\s]+)\)/g

/**
 * `text`, a chapter at `chapterPath`, with each relative link made to work
 * from the page including it: a link to another chapter goes to that
 * chapter's page, anchor kept, and a link to any other file goes to it on
 * GitHub. The chapters link each other as files in the repository, so the
 * links work there too.
 */
const rewriteLinks = (text: string, chapterPath: string, links: ChapterLinks): string =>
  text.replaceAll(LINK, (raw, target: string) => {
    const bare = target.startsWith('<') ? target.slice(1, -1) : target
    if (/^[a-z][a-z\d+.-]*:/i.test(bare) || bare.startsWith('#') || bare.startsWith('/')) return raw
    const hash = bare.indexOf('#')
    const path = hash < 0 ? bare : bare.slice(0, hash)
    const fragment = hash < 0 ? '' : bare.slice(hash)
    const repoPath = posix.normalize(posix.join(posix.dirname(chapterPath), decodeURI(path)))
    const page = links.pages.get(repoPath)
    const url =
      page === undefined
        ? `${links.targets.repositoryUrl}/blob/${links.targets.commit}/${repoPath.split('/').map(encodeURIComponent).join('/')}`
        : encodeURI(posix.relative(posix.dirname(links.page), page))
    return `](${url}${fragment})`
  })

/**
 * `markdown` with each `{{#chapter "<path>"}}` replaced by that file's text,
 * and the paths it included, for naming the chapter in errors. mdbook's own
 * `{{#include}}` can't name a path with spaces, as the docs' file names have,
 * and only warns when the file is missing. Given `links`, the chapter's
 * relative links are rewritten for the page (`rewriteLinks`).
 */
const includeChapters = (
  markdown: string,
  repoRoot: string,
  links?: ChapterLinks
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
    const text = readFileSync(file, 'utf8')
    return links === undefined ? text : rewriteLinks(text, path, links)
  })
  return { markdown: expanded, included, errors }
}

/** A chapter with its directives expanded, and the ones that failed. */
interface Expanded {
  readonly markdown: string
  /** One message per directive that failed, naming it; empty when all built. */
  readonly errors: readonly string[]
  /** The items its `{{#code}}`, `{{#code-link}}` and `{{#covered}}` name. */
  readonly references: readonly ItemReference[]
  /** The files its `{{#covers}}` name. */
  readonly covers: readonly string[]
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
    if (error instanceof DirectiveError)
      return { markdown, errors: [error.message], references: [], covers: [] }
    throw error
  }
  const rendered = await Promise.all(
    found.map(({ directive }) =>
      renderDirective(directive, repoRoot, targets).then(
        ({ text, references }) => ({ text, references, error: undefined }),
        (error: unknown) => {
          if (!(error instanceof DirectiveError)) throw error
          return { text: '', references: [], error: error.message }
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
    references: rendered.flatMap(({ references }) => references),
    covers: found.flatMap(({ directive }) => (directive.kind === 'covers' ? [directive.path] : [])),
  }
}

export type {
  ChapterLinks,
  CodeDirective,
  CoverageDirective,
  Directive,
  Expanded,
  FoundDirective,
  LinkTargets,
  OwningPackage,
  Rendered,
}
export {
  DirectiveError,
  chaptersOf,
  codeIndexPage,
  codeIndexSlug,
  expandDirectives,
  findDirectives,
  includeChapters,
  renderDirective,
}
