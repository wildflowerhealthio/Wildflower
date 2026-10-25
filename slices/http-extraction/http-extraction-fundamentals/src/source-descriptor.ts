import { deepFreeze } from '@wildflowerhealthio/kitchen-sink'
import type { Effect } from 'effect'

import type * as HttpResponseKind from './http-response-kind.ts'

/**
 * "An HTTP source" as one first-class packaging value: the name, the
 * user-facing strings, and the response kinds a source package contributes.
 *
 * @remarks
 * Packaging, deliberately: recognition and identity live on each kind's own
 * `tryRecognize` (the deleted recognition-carrying `Source` value must not
 * creep back in through this type). A consumer that routes or reviews reads
 * `responseKinds` and works per kind; the descriptor exists so a pool
 * assembles from *sources* ("register a source" is appending one of these)
 * and so a UI can label a source without reaching into its kinds. The two
 * behaviours it carries, `mergeResources` and `completeFromExtraction`, are
 * ones no single kind can own: they span the resources several of the
 * source's kinds emit.
 *
 * - `name`: stable identifier for logs and registries (`'fhir-r4'`).
 * - `display`: user-facing strings a review or settings surface shows for the
 *   source as a whole.
 * - `responseKinds`: the source's kinds, pre-adopted where the source supports
 *   archive import, in the order an importer pool routes by. Consumers share
 *   this array by reference.
 * - `mergeResources`: optional; see {@link ResourceMerge}. Absent, two
 *   resources sharing an identity are both written, and the later one wins.
 * - `completeFromExtraction`: optional; see {@link ExtractionCompletion}.
 *   Absent, every resource is written as its kind (and the merge) left it.
 */
interface SourceDescriptor<TParsed> {
  readonly name: string
  readonly display: { readonly title: string; readonly description: string }
  readonly responseKinds: readonly HttpResponseKind.HttpResponseKind<TParsed>[]
  readonly mergeResources?: ResourceMerge<TParsed>
  readonly completeFromExtraction?: ExtractionCompletion<TParsed>
}

/**
 * How a source combines two resources its kinds emitted, in one extraction,
 * under one identity (for a FHIR store, one `resourceType` and `id`): the one
 * resource to write in their place.
 *
 * @param earlier - The copy that arrived first
 * @param later - The copy that arrived after it
 * @returns The resource to write, under the same identity
 *
 * @remarks
 * A source needs one when two of its feeds describe the same thing and each
 * knows fields the other lacks, so neither copy alone is the whole record.
 * Only a consumer that holds every response's resources before it writes
 * them can apply it, as an archive import does. Arrival order is passed so a
 * source can keep last-write-wins, returning `later`, for the resources it has
 * no rule for.
 */
type ResourceMerge<TParsed> = (earlier: TParsed, later: TParsed) => TParsed

/**
 * How a source fills in what one of its resources does not say from what the
 * whole extraction holds: given every resource its kinds emitted in one
 * extraction, merged, the completion of each.
 *
 * @param extraction - Every resource the source's kinds emitted in one
 *   extraction, after {@link ResourceMerge} has run, in arrival order
 * @returns The completion of one resource of `extraction`: the resource to
 *   write in its place, under the same identity
 *
 * @remarks
 * A source needs one when a resource leaves out something only the
 * extraction as a whole says, so no pairwise merge reaches it (a fill that
 * does not say whom it was for, in a capture of one person's account). It
 * sees the extraction once, after every merge, so it reads each
 * resource as it will be written, and a merge never sees what it filled in.
 * Effectful so the source can log what it could not complete. Like
 * {@link ResourceMerge}, only a consumer that holds every response's
 * resources before it writes them can apply it.
 */
type ExtractionCompletion<TParsed> = (
  extraction: readonly TParsed[]
) => Effect.Effect<(resource: TParsed) => TParsed>

/**
 * Same clone-and-freeze contract as `HttpResponseKind.make`, for the
 * descriptor; the kinds themselves are already frozen by that constructor.
 */
const make = <TParsed>(descriptor: SourceDescriptor<TParsed>): SourceDescriptor<TParsed> =>
  deepFreeze({
    name: descriptor.name,
    display: {
      title: descriptor.display.title,
      description: descriptor.display.description,
    },
    responseKinds: [...descriptor.responseKinds],
    ...(descriptor.mergeResources === undefined
      ? {}
      : { mergeResources: descriptor.mergeResources }),
    ...(descriptor.completeFromExtraction === undefined
      ? {}
      : { completeFromExtraction: descriptor.completeFromExtraction }),
  })

/**
 * Flatten a list of sources into the single pool of response kinds a consumer
 * routes or reviews against — every source's `responseKinds`, in source-then-kind
 * order. The one place the "pool is exactly its sources flattened" relation is
 * spelled, so a menu grouped by source and the recognizer route can never
 * disagree on which kinds exist.
 */
const poolOf = <TParsed>(
  sources: readonly SourceDescriptor<TParsed>[]
): readonly HttpResponseKind.HttpResponseKind<TParsed>[] =>
  sources.flatMap((source) => source.responseKinds)

export { make, poolOf }
export type { ExtractionCompletion, ResourceMerge, SourceDescriptor }
