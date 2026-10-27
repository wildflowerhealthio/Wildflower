import type { WithMandatoryId } from '../data-types/with-mandatory-id.ts'
import type { FhirResource } from './fhir-resource.ts'

/**
 * A {@link FhirResource} with its `id` set: one a store can hold, every write
 * addressing a resource by `Type/id`. What adoption makes of every resource a
 * source decodes, and what the write sinks take.
 */
type FhirResourceWithId = WithMandatoryId<FhirResource>

/** Whether `resource` has an `id`, so a store can address it. */
const hasId = (resource: FhirResource): resource is FhirResourceWithId => resource.id !== null

export { hasId }
export type { FhirResourceWithId }
