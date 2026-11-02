/**
 * One record a format's decode read out of a file, as the import stage
 * receives it.
 *
 * @packageDocumentation
 */
import type { FhirResource, FhirResourceWithId } from '@wildflowerhealthio/fhir-r4/resources'
import { Data } from 'effect'

/**
 * A decoded record: one the decode already adopted, or one with the key the
 * import stage adopts it under.
 *
 * @remarks
 * - `Adopted`: already the device's own, with its `wf-` id; the import stage
 *   keeps it as it is. Transitional, while decoders still adopt what they read.
 * - `FromSource`: the resource as its source gave it, beside its key less its
 *   type: the `system` its source id is unique in, an absolute URI, and the
 *   `sourceId` in it. The import stage adopts it (`fhir-r4-adoption`'s
 *   `adoptUnderKey`), its references keyed in its section's system family.
 */
type Type = Data.TaggedEnum<{
  Adopted: { readonly resource: FhirResourceWithId }
  FromSource: {
    readonly system: string
    readonly sourceId: string
    readonly resource: FhirResource
  }
}>

const { Adopted, FromSource, $match } = Data.taggedEnum<Type>()

export { $match, Adopted, FromSource }
export type { Type }
