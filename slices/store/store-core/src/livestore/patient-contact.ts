import { Schema as ES } from 'effect'

import {
  AnnotateArrayWithArbitrary,
  StructNoContext,
  type FieldsNoContext,
} from 'kitchen-sink/schema'
import { Schema as BackboneElementSchema } from '../schemas/base/backbone-element.ts'
import * as Address from '../schemas/complex/address.ts'
import { AdministrativeGender } from '../schemas/complex/administrative-gender.ts'
import * as CodeableConcept from '../schemas/complex/codeable-concept.ts'
import * as ContactPoint from '../schemas/complex/contact-point.ts'
import * as HumanName from '../schemas/complex/human-name.ts'
import * as Period from '../schemas/complex/period.ts'
import * as Reference from '../schemas/complex/reference.ts'

const ResourceType = 'PatientContact' as const
type ResourceType = typeof ResourceType

const fields = {
  address: ES.NullOr(Address.Schema),
  gender: ES.NullOr(AdministrativeGender),
  name: ES.NullOr(HumanName.Schema),
  organization: ES.NullOr(Reference.Schema),
  period: ES.NullOr(Period.Schema),
  relationship: ES.NullOr(
    ES.Array(CodeableConcept.Schema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 }))
  ),
  telecom: ES.NullOr(
    ES.Array(ContactPoint.Schema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 }))
  ),
} as const satisfies FieldsNoContext

/** A contact party (e.g. guardian, partner) for a Patient. */
const Schema = StructNoContext({
  ...BackboneElementSchema.fields,
  ...fields,
})

export { ResourceType, Schema }
