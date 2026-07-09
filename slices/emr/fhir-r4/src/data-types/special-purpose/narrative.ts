import { Schema } from 'effect'

import { StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import * as Element from '../base/element.ts'

const NarrativeStatus = Schema.Union(
  Schema.Literal('generated'),
  Schema.Literal('extensions'),
  Schema.Literal('additional'),
  Schema.Literal('empty')
)

const NarrativeStruct = mutableEncoded(
  StructNoContext({
    ...Element.fields,
    div: Schema.String,
    status: NarrativeStatus,
  })
)

const NarrativeSchema: Schema.Schema<typeof NarrativeStruct.Type, FhirR4.Narrative, never> =
  NarrativeStruct

export { NarrativeSchema as Schema }
