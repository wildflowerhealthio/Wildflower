import { deepFreeze } from '@wildflowerhealthio/kitchen-sink'

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
 * and so a UI can label a source without reaching into its kinds. The one
 * behaviour it carries, `mergeResources`, is one no single kind can own: it
 * spans the resources several of the source's kinds emit.
 *
 * - `name`: stable identifier for logs and registries (`'fhir-r4'`).
 * - `display`: user-facing strings a review or settings surface shows for the
 *   source as a whole.
 * - `responseKinds`: the source's kinds, in the order an importer pool routes
 *   by. Consumers share this array by reference.
 * - `mergeResources`: optional; see {@link ResourceMerge}. Absent, two
 *   resources sharing an identity are both written, and the later one wins.
 */
interface SourceDescriptor<TParsed> {
  readonly name: string
  readonly display: { readonly title: string; readonly description: string }
  readonly responseKinds: readonly HttpResponseKind.HttpResponseKind<TParsed>[]
  readonly mergeResources?: ResourceMerge<TParsed>
}

/**
 * How a source combines two resources its kinds emitted, in one extraction,
 * under one identity (for FHIR, one `resourceType` and key): the one resource
 * to keep in their place.
 *
 * @typeParam TParsed - What the source's kinds parse
 * @typeParam TResource - What the consumer holds them as when it merges, one
 *   of `TParsed`'s subtypes: a merge hands back what it was handed, so a
 *   consumer that has narrowed its records (a HAR import holds them
 *   detached) keeps them narrowed
 * @param earlier - The copy that arrived first
 * @param later - The copy that arrived after it
 * @returns The resource to keep, under the same identity
 *
 * @remarks
 * A source needs one when two of its feeds describe the same thing and each
 * knows fields the other lacks, so neither copy alone is the whole record.
 * Only a consumer that holds every response's resources before it writes
 * them can apply it, as an archive import does. Arrival order is passed so a
 * source can keep last-write-wins, returning `later`, for the resources it has
 * no rule for.
 */
type ResourceMerge<TParsed> = <TResource extends TParsed>(
  earlier: TResource,
  later: TResource
) => TResource

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
export type { ResourceMerge, SourceDescriptor }
