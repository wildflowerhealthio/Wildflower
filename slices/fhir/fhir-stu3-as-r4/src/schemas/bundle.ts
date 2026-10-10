import type { Schema } from 'effect'

import { Bundle } from 'fhir-r4/data-types'

/**
 * A generic STU3 searchset Bundle. The STU3 searchset wire shape
 * (`type: searchset`, `total`, `link`, `entry[].resource`) is identical to R4's, so this
 * is just the fhir-r4 {@link Bundle.Schema} factory, parameterised by whatever
 * STU3 resource schema the caller supplies.
 *
 * Concrete, dialect-specific bundles (the carebook `MedicationRequest` /
 * `MedicationDispense` / mixed shapes the Rexall tunnel returns) live in the
 * `rexall-be-well-collector` slice, not here.
 */
const searchsetBundle = <ResourceSchema extends Schema.Schema.AnyNoContext>(
  resourceSchema: ResourceSchema
): ReturnType<typeof Bundle.Schema<ResourceSchema>> => Bundle.Schema(resourceSchema)

export { searchsetBundle }
