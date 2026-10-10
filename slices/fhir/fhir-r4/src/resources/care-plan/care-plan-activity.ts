import { Schema } from 'effect'

import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import * as BackboneElement from '../../data-types/base/backbone-element.ts'
import * as Annotation from '../../data-types/complex/annotation.ts'
import * as CodeableConcept from '../../data-types/complex/codeable-concept.ts'
import * as IdentifierAndReference from '../../data-types/complex/identifier-and-reference.ts'
import * as CarePlanActivityDetail from './care-plan-activity-detail.ts'

const CarePlanActivityStruct = mutableEncoded(
  StructNoContext({
    ...BackboneElement.fields,
    outcomeCodeableConcept: Schema.optionalWith(
      mutableEncoded(Schema.Array(Schema.suspend(() => CodeableConcept.Schema))),
      { default: (): readonly (typeof CodeableConcept.Schema.Type)[] => [] }
    ),
    outcomeReference: Schema.optionalWith(
      mutableEncoded(Schema.Array(Schema.suspend(() => IdentifierAndReference.ReferenceSchema))),
      { default: (): readonly (typeof IdentifierAndReference.ReferenceSchema.Type)[] => [] }
    ),
    progress: Schema.optionalWith(
      mutableEncoded(Schema.Array(Schema.suspend(() => Annotation.Schema))),
      { default: (): readonly (typeof Annotation.Schema.Type)[] => [] }
    ),
    reference: OrNullAsOptional(Schema.suspend(() => IdentifierAndReference.ReferenceSchema)),
    detail: OrNullAsOptional(CarePlanActivityDetail.Schema),
  })
)

/**
 * Wire schema for FHIR R4 `CarePlan.activity` — one planned action, either a
 * `reference` to a request resource or an inline `detail`, plus its outcomes
 * and progress notes.
 */
const CarePlanActivitySchema: Schema.Schema<
  typeof CarePlanActivityStruct.Type,
  FhirR4.CarePlanActivity,
  never
> = CarePlanActivityStruct

export { CarePlanActivitySchema as Schema }
