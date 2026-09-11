import { Effect } from 'effect'

import type { FhirResource } from 'fhir-r4/resources'
import type { LabeledResource } from 'importer-fundamentals'

import type { BoundFormat, FormatKind, FormatVariant } from '../registry.tsx'
import type { FileReadOutcome } from './use-import-run.ts'

/**
 * Compute the labeled resources for a batch of read files by running each
 * file's own format's `resolve` over its review state. The shell shares the
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
 * throws at render time, so the `runSync` failure is rewrapped with a
 * clear diagnostic naming the file.
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
 * Per-file resolve cache. A caller holds one across renders (a stable
 * per-mount reference, seeded through `useRef`'s initialiser) and
 * hands it to {@link resolvedFor}; entries whose `review` identity is
 * unchanged reuse the cached labeled resources rather than re-resolving.
 */
interface ResolveCache {
  readonly entries: Map<
    string,
    {
      readonly review: unknown
      readonly labeled: FileLabeledResources
    }
  >
}

/** Fresh, empty {@link ResolveCache}. */
const emptyResolveCache = (): ResolveCache => ({ entries: new Map() })

/** A file's format's `resolve` as a uniform callable — union collapses on TParsed = FhirResource. */
type UniformResolve = (
  review: FormatVariant[FormatKind]['review']
) => Effect.Effect<readonly LabeledResource<FhirResource>[]>

const resolveOf = (registry: ResolveRegistry, format: FormatKind): UniformResolve =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- BoundFormat<K>['resolve'] distributes over K in TS; every registered format resolves to FhirResource-labeled resources, so the union is the same shape as UniformResolve.
  registry[format].resolve as UniformResolve

/**
 * Resolve every read file's review state into its labeled resources, caching
 * on review identity. Files whose review kept its reference reuse the cached
 * labeled resources unchanged. Each file's own format's `resolve` is
 * looked up from the registry.
 */
const resolvedFor = (
  registry: ResolveRegistry,
  files: readonly FileReadOutcome[],
  cache?: ResolveCache
): ReadonlyMap<string, FileLabeledResources> => {
  const entries: [string, FileLabeledResources][] = []
  const seen = new Set<string>()
  for (const file of files) {
    if (file._tag !== 'read') continue
    seen.add(file.id)
    const review = file.review
    const cached = cache?.entries.get(file.id)
    if (cached !== undefined && cached.review === review) {
      entries.push([file.id, cached.labeled])
      continue
    }
    const resolve = resolveOf(registry, file.format)
    let labeled: FileLabeledResources
    try {
      labeled = Effect.runSync(resolve(review))
    } catch (cause) {
      throw new Error(
        `resolvedFor: resolve did not fold synchronously for file ${file.id} (format ${file.format}). Every registered format's resolve must be a synchronous Effect.`,
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
export type { FileLabeledResources, ResolveCache, ResolveRegistry }
