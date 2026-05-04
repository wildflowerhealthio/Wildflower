import { Schema } from 'effect'

import { Code } from 'emr-core/schemas'
import type { Coding as StoreCoding } from 'emr-core/schemas'
import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type FhirR4 from 'fhir/r4.d.ts'

import * as Element from '../base/element.ts'

const CodingSchema: Schema.Schema<typeof StoreCoding.Schema.Type, FhirR4.Coding, never> =
  mutableEncoded(
    StructNoContext({
      ...Element.fields,
      code: OrNullAsOptional(Code),
      display: OrNullAsOptional(Schema.String),
      system: OrNullAsOptional(Schema.String),
      userSelected: OrNullAsOptional(Schema.Boolean),
      version: OrNullAsOptional(Schema.String),
    })
  )

export { CodingSchema as Schema }
