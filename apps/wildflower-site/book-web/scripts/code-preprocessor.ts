#!/usr/bin/env node
// The mdbook preprocessor (`[preprocessor.code]` in book.toml) that expands
// each page's `{{#chapter}}`, `{{#code}}`, `{{#code-link}}` and `{{#item}}`
// directives (`directives.ts`), after indexing every page's `{{#item}}`s so a
// doc comment's links can land on any page. mdbook runs it from the book's
// root:
//
//   code-preprocessor.ts supports <renderer>   exit 0: every renderer
//   code-preprocessor.ts < [context, book]     the book, expanded, on stdout
//
// Every directive that fails is reported on stderr, naming its chapter, and
// the build fails. GitHub links name `GITHUB_SHA` (CI's checkout), or HEAD.
// Then the coverage of the files the chapters' `{{#covers}}` name
// (coverage.ts) goes to stderr: a count, and a warning per item the book
// doesn't show, per item, test, field and variant without a doc comment, and
// per test no `{{#item tests=…}}` or `{{#code}}` shows.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  coverableFile,
  coverageReport,
  formatCoverage,
  type CoveredFile,
  type ItemReference,
} from './coverage.ts'
import {
  chaptersOf,
  expandDirectives,
  includeChapters,
  indexBook,
  type LinkTargets,
} from './directives.ts'

interface Chapter {
  name: string
  content: string
  source_path?: string | null
  sub_items?: unknown[]
}

const isChapter = (value: unknown): value is Chapter =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { content?: unknown }).content === 'string' &&
  typeof (value as { name?: unknown }).name === 'string'

/** Every chapter in mdbook's book JSON, wherever it nests (`{ Chapter: … }` items, `sub_items`). */
const chaptersIn = (value: unknown): Chapter[] => {
  if (Array.isArray(value)) return value.flatMap(chaptersIn)
  if (typeof value !== 'object' || value === null) return []
  const own = isChapter(value) ? [value] : []
  return [...own, ...Object.values(value).flatMap(chaptersIn)]
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

const main = async (): Promise<void> => {
  if (process.argv[2] === 'supports') return
  const input: unknown = JSON.parse(readFileSync(0, 'utf8'))
  const parts: readonly unknown[] = Array.isArray(input) ? input : []
  const [context, book] = parts
  const bookRoot: unknown =
    typeof context === 'object' && context !== null ? Reflect.get(context, 'root') : undefined
  if (typeof bookRoot !== 'string') throw new Error('mdbook passed no [context, book] on stdin')
  const repoRoot = git(bookRoot, 'rev-parse', '--show-toplevel')
  const targets: LinkTargets = {
    repositoryUrl: 'https://github.com/wildflowerhealthio/Wildflower',
    commit: process.env['GITHUB_SHA'] || git(repoRoot, 'rev-parse', 'HEAD'),
    // Previews have no code index of their own, so every build links production's.
    codeIndexUrl: 'https://wildflowerhealth.io/code-index/',
  }
  const chapters = chaptersIn(book)
  // Each included chapter → its page, so chapters' links to each other land.
  const pages = new Map(
    chapters.flatMap((chapter) =>
      chaptersOf(chapter.content).map((path) => [path, chapter.source_path ?? ''] as const)
    )
  )
  const references: ItemReference[] = []
  const covers = new Set<string>()
  const included = chapters.map((chapter) =>
    includeChapters(chapter.content, repoRoot, {
      page: chapter.source_path ?? '',
      pages,
      targets,
    })
  )
  // Every {{#item}} in the book, first, so a doc link can land on any page.
  const index = indexBook(
    chapters.map((chapter, i) => ({
      page: chapter.source_path ?? '',
      markdown: included[i].markdown,
    })),
    repoRoot
  )
  const failures = (
    await Promise.all(
      chapters.map(async (chapter, i) => {
        const page = `src/${chapter.source_path ?? '?'}`
        const withChapters = included[i]
        const expanded = await expandDirectives(withChapters.markdown, repoRoot, targets, {
          page: chapter.source_path ?? '',
          index,
        })
        const { markdown, errors } = expanded
        references.push(...expanded.references)
        expanded.covers.forEach((path) => covers.add(path))
        chapter.content = markdown
        const where = withChapters.included.length > 0 ? withChapters.included.join(', ') : page
        return [
          ...withChapters.errors.map((error) => `${page}: ${error}`),
          ...errors.map((error) => `${where}: ${error}`),
        ]
      })
    )
  ).flat()
  if (failures.length > 0) {
    process.stderr.write(
      `The book has ${failures.length} broken directive${failures.length === 1 ? '' : 's'}:\n${failures.map((f) => `  ${f}`).join('\n')}\n`
    )
    process.exit(1)
  }
  const coveredFiles: CoveredFile[] = await Promise.all(
    [...covers].toSorted().map(async (path) => ({
      path,
      ...(await coverableFile(readFileSync(join(repoRoot, path), 'utf8'))),
    }))
  )
  if (coveredFiles.length > 0)
    process.stderr.write(formatCoverage(coverageReport(coveredFiles, references)))
  process.stdout.write(JSON.stringify(book))
}

await main()
