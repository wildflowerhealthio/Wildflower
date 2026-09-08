import { Effect } from 'effect'

import { type HttpResponseKind, SourceDescriptor } from 'http-extraction-fundamentals'
import { Review } from 'importer-fundamentals'

import type { FileReadOutcome } from './use-import-run.ts'

/**
 * Compute the previews for a batch of read files under their selections. The
 * shell shares the resulting map between the `PreviewPanel`'s render
 * (per-resource rows + counts) and the confirm step (the write set is
 * `Review.chosenResources` over exactly these), keeping the "is the same
 * object" argument honest.
 *
 * @remarks
 * Reads the pool from the sources on demand rather than storing a derived
 * value, matching how the descriptor exposes only `sources`. Pure — parses
 * fold synchronously through `runSync` in every registered format today; a
 * kind whose `parse` ever suspends throws at render time, so the `runSync`
 * failure is rewrapped with a clear diagnostic naming the file.
 *
 * A caller may pass a persistent {@link PreviewsCache} across renders to
 * reuse previews whose parse-relevant selection slices (`enabledKinds`,
 * `overrides`) and `responses` array kept their identity — the exclusion
 * axis never changes what is parsed, so a per-resource checkbox toggle can
 * reuse the previous previews unchanged. Without a cache, every call
 * re-parses.
 *
 * @typeParam TParsed - The resource type the sources' kinds decode to; the
 *   returned previews carry it through so the shell and the confirm see the
 *   same typed resources rather than an `unknown` bag.
 *
 * @packageDocumentation
 */
type FilePreviews<TParsed> = readonly Review.PreviewedResponse<
  HttpResponseKind.HttpResponseKind<TParsed>,
  TParsed
>[]

/**
 * Per-file preview cache. A caller holds one across renders (a stable
 * per-mount reference, seeded through `useState`'s lazy initialiser) and
 * hands it to {@link previewsFor}; entries whose parse-relevant identities
 * are unchanged reuse the cached previews rather than re-parsing.
 */
interface PreviewsCache<TParsed> {
  readonly entries: Map<
    string,
    {
      readonly responses: readonly unknown[]
      readonly enabledKinds: ReadonlySet<string>
      readonly overrides: ReadonlyMap<string, string>
      readonly previews: FilePreviews<TParsed>
    }
  >
}

/** Fresh, empty {@link PreviewsCache}. */
const emptyPreviewsCache = <TParsed>(): PreviewsCache<TParsed> => ({ entries: new Map() })

const runPreview = <TParsed>(
  pool: readonly HttpResponseKind.HttpResponseKind<TParsed>[],
  file: Extract<FileReadOutcome, { readonly _tag: 'read' }>,
  selection: Review.Selection<TParsed>
): FilePreviews<TParsed> => {
  try {
    return Effect.runSync(Review.preview(pool, file.responses, selection))
  } catch (cause) {
    throw new Error(
      `previewsFor: Review.preview did not fold synchronously for file ${file.id}. Every registered kind's parse must be a synchronous Effect.`,
      { cause }
    )
  }
}

const previewsFor = <TParsed>(
  sources: readonly SourceDescriptor.SourceDescriptor<TParsed>[],
  files: readonly FileReadOutcome[],
  selectionFor: (fileId: string) => Review.Selection<TParsed>,
  cache?: PreviewsCache<TParsed>
): ReadonlyMap<string, FilePreviews<TParsed>> => {
  const pool = SourceDescriptor.poolOf(sources)
  const entries: [string, FilePreviews<TParsed>][] = []
  const seen = new Set<string>()
  for (const file of files) {
    if (file._tag !== 'read') continue
    seen.add(file.id)
    const selection = selectionFor(file.id)
    const cached = cache?.entries.get(file.id)
    if (
      cached !== undefined &&
      cached.responses === file.responses &&
      cached.enabledKinds === selection.enabledKinds &&
      cached.overrides === selection.overrides
    ) {
      entries.push([file.id, cached.previews])
      continue
    }
    const fresh = runPreview(pool, file, selection)
    cache?.entries.set(file.id, {
      responses: file.responses,
      enabledKinds: selection.enabledKinds,
      overrides: selection.overrides,
      previews: fresh,
    })
    entries.push([file.id, fresh])
  }
  if (cache !== undefined) {
    // Map iteration in JS visits only existing keys; a deleted-but-unvisited
    // key is skipped — no snapshot needed.
    for (const id of cache.entries.keys()) if (!seen.has(id)) cache.entries.delete(id)
  }
  return new Map(entries)
}

export { emptyPreviewsCache, previewsFor }
export type { FilePreviews, PreviewsCache }
