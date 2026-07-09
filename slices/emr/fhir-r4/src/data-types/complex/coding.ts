import { Schema } from 'effect'

import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import { Code } from '../base/code.ts'
import { registerDatatypeSchema } from '../base/datatype-registry.ts'
import * as Element from '../base/element.ts'

const CodingStruct = mutableEncoded(
  StructNoContext({
    ...Element.fields,
    code: OrNullAsOptional(Code),
    display: OrNullAsOptional(Schema.String),
    system: OrNullAsOptional(Schema.URL),
    userSelected: OrNullAsOptional(Schema.Boolean),
    version: OrNullAsOptional(Schema.String),
  })
)

const CodingSchema: Schema.Schema<typeof CodingStruct.Type, FhirR4.Coding, never> = CodingStruct

registerDatatypeSchema('Coding', CodingSchema)

export { CodingSchema as Schema }
