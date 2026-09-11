import { Effect } from 'effect'

import type { FhirResource } from 'fhir-r4/resources'
import type { LabeledResource } from 'importer-fundamentals'

import type { FileReadOutcome } from './use-import-run.ts'

/**
 * Compute the labeled resources for a batch of read files by running the
 * format's `resolve` over each file's review state. The shell shares the
 * resulting map between the `PreviewPanel`'s render (per-resource rows +
 * counts) and the confirm step (the write set is `Review.chosenResources`
 * over exactly these), keeping the "is the same object" argument honest.
 *
 * @remarks
 * A caller may pass a persistent {@link ResolveCache} across renders to
 * reuse labeled resources whose `review` object kept its identity — a
 * per-resource checkbox toggle never changes the review, so it reuses the
 * previous labeled resources unchanged. Without a cache, every call
 * re-resolves. Pure — resolves fold synchronously through `runSync` in
 * every registered format today; a format whose `resolve` ever suspends
 * throws at render time, so the `runSync` failure is rewrapped with a clear
 * diagnostic naming the file.
 *
 * @packageDocumentation
 */

/** The `resolve` half of a bound format — one function the cache invokes. */
type Resolve<TReview> = (review: TReview) => Effect.Effect<readonly LabeledResource<FhirResource>[]>

/** The resolved labeled resources for one file. */
type FileLabeledResources = readonly LabeledResource<FhirResource>[]

/**
 * Per-file resolve cache. A caller holds one across renders (a stable
 * per-mount reference, seeded through `useRef`'s initialiser) and
 * hands it to {@link resolvedFor}; entries whose `review` identity is
 * unchanged reuse the cached labeled resources rather than re-resolving.
 */
interface ResolveCache<TReview> {
  readonly entries: Map<
    string,
    {
      readonly review: TReview
      readonly labeled: FileLabeledResources
    }
  >
}

/** Fresh, empty {@link ResolveCache}. */
const emptyResolveCache = <TReview>(): ResolveCache<TReview> => ({ entries: new Map() })

/**
 * Resolve every read file's review state into its labeled resources, caching
 * on review identity. Files whose review kept its reference reuse the cached
 * labeled resources unchanged.
 */
const resolvedFor = <TReview>(
  resolve: Resolve<TReview>,
  files: readonly FileReadOutcome[],
  reviewFor: (fileId: string) => TReview,
  cache?: ResolveCache<TReview>
): ReadonlyMap<string, FileLabeledResources> => {
  const entries: [string, FileLabeledResources][] = []
  const seen = new Set<string>()
  for (const file of files) {
    if (file._tag !== 'read') continue
    seen.add(file.id)
    const review = reviewFor(file.id)
    const cached = cache?.entries.get(file.id)
    if (cached !== undefined && cached.review === review) {
      entries.push([file.id, cached.labeled])
      continue
    }
    let labeled: FileLabeledResources
    try {
      labeled = Effect.runSync(resolve(review))
    } catch (cause) {
      throw new Error(
        `resolvedFor: resolve did not fold synchronously for file ${file.id}. Every registered format's resolve must be a synchronous Effect.`,
        { cause }
      )
    }
    cache?.entries.set(file.id, { review, labeled })
    entries.push([file.id, labeled])
  }
  if (cache !== undefined) {
    for (const id of cache.entries.keys()) if (!seen.has(id)) cache.entries.delete(id)
  }
  return new Map(entries)
}

export { emptyResolveCache, resolvedFor }
export type { FileLabeledResources, ResolveCache }
