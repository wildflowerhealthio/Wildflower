import { Schema } from 'effect'

import {
  OrNullAsOptional,
  StructNoContext,
  mutableEncoded,
} from '@wildflowerhealthio/kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import * as BackboneElement from '../../data-types/base/backbone-element.ts'
import {
  filterForExclusiveChoiceElementSet,
  choiceElementSetPassthroughFields,
} from '../../data-types/base/choice-element-passthrough-fields.ts'
import * as ChoiceElementSet from '../../data-types/base/choice-element-set.ts'
import * as CodeableConcept from '../../data-types/complex/codeable-concept.ts'
import * as IdentifierAndReference from '../../data-types/complex/identifier-and-reference.ts'
import * as Quantity from '../../data-types/complex/quantity.ts'

/**
 * FHIR R4 value set for `CarePlan.activity.detail.kind` (the
 * `care-plan-activity-kind` binding): the resource type the activity would
 * be requested as.
 */
const KindSchema = Schema.Literal(
  'Appointment',
  'CommunicationRequest',
  'DeviceRequest',
  'MedicationRequest',
  'NutritionOrder',
  'Task',
  'ServiceRequest',
  'VisionPrescription'
)

/**
 * FHIR R4 value set for `CarePlan.activity.detail.status`: not-started |
 * scheduled | in-progress | on-hold | completed | cancelled | stopped |
 * unknown | entered-in-error.
 */
const StatusSchema = Schema.Literal(
  'not-started',
  'scheduled',
  'in-progress',
  'on-hold',
  'completed',
  'cancelled',
  'stopped',
  'unknown',
  'entered-in-error'
)

const referenceArray = Schema.optionalWith(
  mutableEncoded(Schema.Array(Schema.suspend(() => IdentifierAndReference.ReferenceSchema))),
  { default: (): readonly (typeof IdentifierAndReference.ReferenceSchema.Type)[] => [] }
)

const CarePlanActivityDetailStruct = mutableEncoded(
  StructNoContext({
    ...BackboneElement.fields,
    kind: OrNullAsOptional(KindSchema),
    instantiatesCanonical: Schema.optionalWith(mutableEncoded(Schema.Array(Schema.String)), {
      default: (): readonly string[] => [],
    }),
    instantiatesUri: Schema.optionalWith(mutableEncoded(Schema.Array(Schema.String)), {
      default: (): readonly string[] => [],
    }),
    code: OrNullAsOptional(Schema.suspend(() => CodeableConcept.Schema)),
    reasonCode: Schema.optionalWith(
      mutableEncoded(Schema.Array(Schema.suspend(() => CodeableConcept.Schema))),
      { default: (): readonly (typeof CodeableConcept.Schema.Type)[] => [] }
    ),
    reasonReference: referenceArray,
    goal: referenceArray,
    status: StatusSchema,
    statusReason: OrNullAsOptional(Schema.suspend(() => CodeableConcept.Schema)),
    doNotPerform: OrNullAsOptional(Schema.Boolean),
    ...choiceElementSetPassthroughFields(
      'scheduled',
      ChoiceElementSet.FhirR4SetChoices['CarePlan.activity.detail.scheduled[x]']
    ),
    location: OrNullAsOptional(Schema.suspend(() => IdentifierAndReference.ReferenceSchema)),
    performer: referenceArray,
    ...choiceElementSetPassthroughFields(
      'product',
      ChoiceElementSet.FhirR4SetChoices['CarePlan.activity.detail.product[x]']
    ),
    dailyAmount: OrNullAsOptional(Schema.suspend(() => Quantity.Schema)),
    quantity: OrNullAsOptional(Schema.suspend(() => Quantity.Schema)),
    description: OrNullAsOptional(Schema.String),
  })
).pipe(
  filterForExclusiveChoiceElementSet(
    'scheduled',
    ChoiceElementSet.FhirR4SetChoices['CarePlan.activity.detail.scheduled[x]']
  ),
  filterForExclusiveChoiceElementSet(
    'product',
    ChoiceElementSet.FhirR4SetChoices['CarePlan.activity.detail.product[x]']
  )
)

/**
 * Wire schema for FHIR R4 `CarePlan.activity.detail` — an activity described
 * inline on the plan rather than through a separate request resource.
 *
 * @remarks
 * `scheduled[x]` and `product[x]` each allow at most one populated slot.
 */
const CarePlanActivityDetailSchema: Schema.Schema<
  typeof CarePlanActivityDetailStruct.Type,
  FhirR4.CarePlanActivityDetail,
  never
> = CarePlanActivityDetailStruct

export { CarePlanActivityDetailSchema as Schema, KindSchema, StatusSchema }
