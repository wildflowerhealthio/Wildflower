import { Schema } from 'effect'

import {
  OrNullAsOptional,
  StructNoContext,
  mutableEncoded,
} from '@wildflowerhealthio/kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import { registerDatatypeSchema } from '../base/datatype-registry.ts'
import * as Element from '../base/element.ts'
import * as FhirString from '../base/fhir-string.ts'
import * as Period from './period.ts'

const AddressStruct = mutableEncoded(
  StructNoContext({
    ...Element.fields,
    city: FhirString.Optional,
    country: FhirString.Optional,
    district: FhirString.Optional,
    line: Schema.optionalWith(mutableEncoded(FhirString.Array), {
      default: () => [] as readonly string[],
    }),
    period: OrNullAsOptional(Schema.suspend(() => Period.Schema)),
    postalCode: FhirString.Optional,
    state: FhirString.Optional,
    text: FhirString.Optional,
    type: OrNullAsOptional(
      Schema.Union(Schema.Literal('postal'), Schema.Literal('physical'), Schema.Literal('both'))
    ),
    use: OrNullAsOptional(
      Schema.Union(
        Schema.Literal('home'),
        Schema.Literal('work'),
        Schema.Literal('temp'),
        Schema.Literal('old'),
        Schema.Literal('billing')
      )
    ),
  })
)

const AddressSchema: Schema.Schema<typeof AddressStruct.Type, FhirR4.Address, never> = AddressStruct

registerDatatypeSchema('Address', AddressSchema)

export { AddressSchema as Schema }
