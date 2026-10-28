import type { WithMandatoryId } from '../data-types/with-mandatory-id.ts'
import type { FhirResource } from './fhir-resource.ts'

/**
 * A {@link FhirResource} with its `id` set: one a store can hold, every write
 * addressing a resource by `Type/id`. What adoption makes of every resource a
 * source decodes, and what the write sinks take.
 */
type FhirResourceWithId = WithMandatoryId<FhirResource>

/**
 * Whether `resource` has an `id`, so a store can address it.
 *
 * @remarks
 * Generic in the resource so the narrowing keeps its type: a `Patient.Type`
 * narrows to a Patient with an id, through {@link WithMandatoryId}'s
 * distribution, rather than to the whole {@link FhirResourceWithId} union.
 */
const hasId = <T extends FhirResource>(resource: T): resource is WithMandatoryId<T> =>
  resource.id !== null

export { hasId }
export type { FhirResourceWithId }
