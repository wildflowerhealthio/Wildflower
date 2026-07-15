import { Schema } from 'effect'

import { Bundle } from 'fhir-r4/data-types'

import * as MedicationDispense from './medication-dispense.ts'
import * as MedicationRequest from './medication-request.ts'

/**
 * The carebook STU3 searchset Bundle wire shape (`type: searchset`, `total`,
 * `link`, `entry[].resource`) is identical to R4's, so the STU3 slice reuses
 * the fhir-r4 {@link Bundle.Schema} factory directly, parameterised by the STU3
 * dialect resource schemas.
 *
 * `searchsetBundle` is the general factory; the named exports below are the two
 * concrete shapes the Rexall tunnel returns:
 *  - a list/detail bundle of `MedicationRequest`s (with contained `Medication`),
 *  - a bundle of `MedicationDispense`s,
 *  - a mixed bundle holding either resource type (discriminated on
 *    `resourceType`).
 */
const searchsetBundle = <ResourceSchema extends Schema.Schema.AnyNoContext>(
  resourceSchema: ResourceSchema
): ReturnType<typeof Bundle.Schema<ResourceSchema>> => Bundle.Schema(resourceSchema)

const MedicationRequestBundle = searchsetBundle(MedicationRequest.Schema)

const MedicationDispenseBundle = searchsetBundle(MedicationDispense.Schema)

/** Either dialect resource, discriminated on `resourceType`. */
const MedicationResource = Schema.Union(MedicationRequest.Schema, MedicationDispense.Schema)

const MedicationBundle = searchsetBundle(MedicationResource)

export {
  searchsetBundle,
  MedicationRequestBundle,
  MedicationDispenseBundle,
  MedicationResource,
  MedicationBundle,
}
