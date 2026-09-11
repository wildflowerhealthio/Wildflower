import { Effect, Match } from 'effect'

import type { FhirResource } from 'fhir-r4/resources'
import type { LabeledResource } from 'importer-fundamentals'

import type { BoundFormat, FormatKind, FormatReview } from '../registry.tsx'
import type { FileReadOutcome, ReadFile } from './use-import-run.ts'

/**
 * Compute the labeled resources for a batch of read files by running each
 * file's own format's `resolve` over its tagged review. The shell shares
 * the resulting map between the `PreviewPanel`'s render (per-resource
 * rows + counts) and the confirm step (the write set is
 * `Review.chosenResources` over exactly these), keeping the "is the
 * same object" argument honest.
 *
 * @remarks
 * A caller may pass a persistent {@link ResolveCache} across renders to
 * reuse labeled resources whose {@link FormatReview} identity is
 * unchanged — a per-resource checkbox toggle never changes the review,
 * so it reuses the previous labeled resources unchanged. Without a
 * cache, every call re-resolves. Pure — resolves fold synchronously
 * through `runSync` in every registered format today; a format whose
 * `resolve` ever suspends throws at render time, so the `runSync`
 * failure is rewrapped with a clear diagnostic naming the file. Each
 * file's tagged review is `Match.value`d on its `format` tag so
 * `registry[K].resolve(review)` type-checks per branch — no cast.
 *
 * @packageDocumentation
 */

/** The registry-shaped structure this module reads to look up each file's `resolve`. */
type ResolveRegistry = {
  readonly [K in FormatKind]: Pick<BoundFormat<K>, 'resolve'>
}

/** The resolved labeled resources for one file. */
type FileLabeledResources = readonly LabeledResource<FhirResource>[]

/**
 * Per-review resolve cache — a `WeakMap` from a tagged review object to
 * its resolved labeled resources.
 *
 * @remarks
 * Identity is the natural hit condition: a per-resource checkbox toggle
 * never changes the {@link FormatReview} object, so the same tagged
 * review resolves once and every subsequent render reuses the result.
 * A `WeakMap` auto-clears an entry when the tagged review is no longer
 * reachable, so there is no per-file eviction to maintain — a file that
 * leaves the batch drops out on its own. A caller holds one across
 * renders (a stable per-mount reference, seeded through `useRef`'s
 * initialiser) and hands it to {@link resolvedFor}.
 */
type ResolveCache = WeakMap<FormatReview, FileLabeledResources>

/** Fresh, empty {@link ResolveCache}. */
const emptyResolveCache = (): ResolveCache => new WeakMap()

/**
 * Resolve one tagged review through its format's own `resolve`. `Match.value`
 * on the review's `format` tag narrows `tagged.review` to that K's review
 * type, so `registry[K].resolve(review)` type-checks — no cast.
 */
const resolveOne = (
  registry: ResolveRegistry,
  tagged: FormatReview
): Effect.Effect<FileLabeledResources> =>
  Match.value(tagged).pipe(
    Match.when({ format: 'har' }, (t) => registry.har.resolve(t.review)),
    Match.when({ format: 'lifelabs-pdf' }, (t) => registry['lifelabs-pdf'].resolve(t.review)),
    Match.exhaustive
  )

/**
 * Resolve every read file's tagged review into its labeled resources,
 * caching on {@link FormatReview} identity. Files whose review kept its
 * reference (same override object) reuse the cached labeled resources
 * unchanged. The caller passes each file's tagged review — an override
 * when one exists, otherwise the read outcome's own — so the cache and
 * the render agree on identity.
 */
const resolvedFor = (
  registry: ResolveRegistry,
  files: readonly FileReadOutcome[],
  reviewFor: (file: ReadFile) => FormatReview,
  cache?: ResolveCache
): ReadonlyMap<string, FileLabeledResources> => {
  const entries: [string, FileLabeledResources][] = []
  for (const file of files) {
    if (file._tag !== 'read') continue
    const tagged = reviewFor(file)
    const cached = cache?.get(tagged)
    if (cached !== undefined) {
      entries.push([file.id, cached])
      continue
    }
    let labeled: FileLabeledResources
    try {
      labeled = Effect.runSync(resolveOne(registry, tagged))
    } catch (cause) {
      throw new Error(
        `resolvedFor: resolve did not fold synchronously for file ${file.id} (format ${tagged.format}). Every registered format's resolve must be a synchronous Effect.`,
        { cause }
      )
    }
    cache?.set(tagged, labeled)
    entries.push([file.id, labeled])
  }
  return new Map(entries)
}

export { emptyResolveCache, resolvedFor }
export type { FileLabeledResources, ResolveCache, ResolveRegistry }
