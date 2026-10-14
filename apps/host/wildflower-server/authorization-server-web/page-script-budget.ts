import { gzipSync } from 'node:zlib'

import type { Plugin } from 'vite'

/**
 * The most JavaScript, gzipped, one page may load before it can run, beside
 * the shared React chunk.
 */
const PAGE_SCRIPT_BUDGET_BYTES = 150 * 1024

/**
 * The chunk every page shares, React and React DOM, which the browser caches
 * once for all of them. The build names it (`vite.config.ts`'s
 * `codeSplitting` group), and the budget leaves it out.
 */
const SHARED_REACT_CHUNK = 'react'

/** What the budget reads of a built JavaScript chunk. */
interface ScriptChunk {
  readonly fileName: string
  /** Whether the chunk is a page's entry: one per HTML input. */
  readonly isEntry: boolean
  /** The entry's input name, which is the page's (`consent` for `consent.html`). */
  readonly name: string
  readonly code: string
  /** The chunks this one imports statically, by `fileName`; each loads before it runs. */
  readonly imports: readonly string[]
}

/** One page's script weight: every chunk its entry loads before it runs. */
interface PageScriptSize {
  readonly page: string
  readonly gzippedBytes: number
}

/**
 * The gzipped size of each page's JavaScript: its entry chunk and every chunk
 * the entry imports statically, directly or through another, each counted
 * once, but for the {@link SHARED_REACT_CHUNK}. Any other chunk two pages
 * share counts toward both, since each page loads it; a dynamic import does
 * not, since it loads later, if at all.
 */
const pageScriptSizes = (chunks: readonly ScriptChunk[]): readonly PageScriptSize[] => {
  const chunksByFileName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]))
  const loadedBefore = (entry: ScriptChunk): ReadonlySet<ScriptChunk> => {
    const loaded = new Set<ScriptChunk>()
    const pending = [entry]
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      if (loaded.has(next) || next.name === SHARED_REACT_CHUNK) continue
      loaded.add(next)
      for (const fileName of next.imports) {
        const imported = chunksByFileName.get(fileName)
        if (imported !== undefined) pending.push(imported)
      }
    }
    return loaded
  }
  return chunks
    .filter((chunk) => chunk.isEntry)
    .map((entry) => ({
      page: entry.name,
      gzippedBytes: [...loadedBefore(entry)].reduce(
        (total, chunk) => total + gzipSync(chunk.code).byteLength,
        0
      ),
    }))
}

/**
 * Fails the build when a page's JavaScript beside React (see
 * {@link pageScriptSizes}) is over {@link PAGE_SCRIPT_BUDGET_BYTES} gzipped,
 * naming each page and its size.
 * Runs on the minified output, after the bundle is generated.
 */
const pageScriptBudget = (): Plugin => ({
  name: 'authorization-server-web:page-script-budget',
  apply: 'build',
  generateBundle(_options, bundle) {
    const chunks = Object.values(bundle).flatMap((output): readonly ScriptChunk[] =>
      output.type === 'chunk' ? [output] : []
    )
    const overBudget = pageScriptSizes(chunks).filter(
      (size) => size.gzippedBytes > PAGE_SCRIPT_BUDGET_BYTES
    )
    if (overBudget.length > 0) {
      this.error(
        `Over the ${PAGE_SCRIPT_BUDGET_BYTES} B gzipped page script budget: ${overBudget
          .map((size) => `${size.page} (${size.gzippedBytes} B)`)
          .join(', ')}`
      )
    }
  },
})

export { PAGE_SCRIPT_BUDGET_BYTES, pageScriptBudget, pageScriptSizes, SHARED_REACT_CHUNK }
export type { PageScriptSize, ScriptChunk }
