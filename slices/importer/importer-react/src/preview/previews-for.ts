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
 * fold synchronously through `runSync` in every registered format today.
 *
 * @typeParam TParsed - The resource type the sources' kinds decode to; the
 *   returned previews carry it through so the shell and the confirm see the
 *   same typed resources rather than an `unknown` bag.
 *
 * @packageDocumentation
 */
const previewsFor = <TParsed>(
  sources: readonly SourceDescriptor.SourceDescriptor<TParsed>[],
  files: readonly FileReadOutcome[],
  selectionFor: (fileId: string) => Review.Selection
): ReadonlyMap<
  string,
  readonly Review.PreviewedResponse<HttpResponseKind.HttpResponseKind<TParsed>, TParsed>[]
> => {
  const pool = SourceDescriptor.poolOf(sources)
  const entries: [
    string,
    readonly Review.PreviewedResponse<HttpResponseKind.HttpResponseKind<TParsed>, TParsed>[],
  ][] = []
  for (const file of files) {
    if (file._tag !== 'read') continue
    entries.push([
      file.id,
      Effect.runSync(Review.preview(pool, file.responses, selectionFor(file.id))),
    ])
  }
  return new Map(entries)
}

export { previewsFor }
