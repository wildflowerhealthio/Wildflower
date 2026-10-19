#!/usr/bin/env node
// The mdbook preprocessor (`[preprocessor.code]` in book.toml) that expands
// each page's `{{#chapter}}`, `{{#code}}` and `{{#code-link}}` directives
// (`directives.ts`). mdbook runs it from the book's root:
//
//   code-preprocessor.ts supports <renderer>   exit 0: every renderer
//   code-preprocessor.ts < [context, book]     the book, expanded, on stdout
//
// Every directive that fails is reported on stderr, naming its chapter, and
// the build fails. GitHub links name `GITHUB_SHA` (CI's checkout), or HEAD.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

import { expandDirectives, includeChapters, type LinkTargets } from './directives.ts'

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
  const failures = (
    await Promise.all(
      chaptersIn(book).map(async (chapter) => {
        const page = `src/${chapter.source_path ?? '?'}`
        const withChapters = includeChapters(chapter.content, repoRoot)
        const { markdown, errors } = await expandDirectives(
          withChapters.markdown,
          repoRoot,
          targets
        )
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
  process.stdout.write(JSON.stringify(book))
}

await main()
