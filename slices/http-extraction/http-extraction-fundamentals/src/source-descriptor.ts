import { deepFreeze } from 'kitchen-sink'

import type * as HttpResponseKind from './http-response-kind.ts'

/**
 * "An HTTP source" as one first-class packaging value: the name, the
 * user-facing strings, and the response kinds a source package contributes —
 * the per-source analogue of the collector slice's `CollectorDescriptor` and
 * the importer slice's `FileImporterDescriptor`.
 *
 * @remarks
 * Packaging only, deliberately: recognition and identity live on each kind's
 * own `tryRecognize` (the deleted recognition-carrying `Source` value must not
 * creep back in through this type). A consumer that routes or reviews reads
 * `responseKinds` and works per kind; the descriptor exists so a pool
 * assembles from *sources* ("register a source" is appending one of these)
 * and so a UI can label a source without reaching into its kinds.
 *
 * - `name`: stable identifier for logs and registries (`'fhir-r4'`).
 * - `display`: user-facing strings a review or settings surface shows for the
 *   source as a whole.
 * - `responseKinds`: the source's kinds, pre-adopted where the source supports
 *   archive import, in the order both the live plan and an importer pool route
 *   by. Consumers share this array by reference — that identity is what the
 *   live==archive parity pins rest on.
 */
interface SourceDescriptor<TParsed> {
  readonly name: string
  readonly display: { readonly title: string; readonly description: string }
  readonly responseKinds: readonly HttpResponseKind.HttpResponseKind<TParsed>[]
}

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
export type { SourceDescriptor }
