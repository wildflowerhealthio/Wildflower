import { Schema } from 'effect'

import { CodeableConcept, IdentifierAndReference } from 'fhir-r4/data-types'

/**
 * Re-readers for the `any`-typed choice slots on the decoded R4 resources:
 * `medication[x]` and `Extension.value[x]` come through untyped, so a step
 * that reads one decodes it through these first.
 */

/** A decoded R4 `CodeableConcept`. */
const DecodedCodeableConcept = Schema.typeSchema(CodeableConcept.Schema)
type DecodedCodeableConcept = typeof DecodedCodeableConcept.Type

/** A decoded R4 `Reference`. */
const DecodedReference = Schema.typeSchema(IdentifierAndReference.ReferenceSchema)

const decodeCodeableConcept = Schema.decodeUnknownOption(DecodedCodeableConcept)
const decodeReference = Schema.decodeUnknownOption(DecodedReference)

export { DecodedCodeableConcept, DecodedReference, decodeCodeableConcept, decodeReference }
