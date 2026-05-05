import { Schema } from 'effect'

import type { Narrative as StoreNarrative } from 'emr-core/schemas'
import { StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import * as Element from '../base/element.ts'

const NarrativeStatus = Schema.Union(
  Schema.Literal('generated'),
  Schema.Literal('extensions'),
  Schema.Literal('additional'),
  Schema.Literal('empty')
)

const NarrativeSchema: Schema.Schema<typeof StoreNarrative.Schema.Type, FhirR4.Narrative, never> =
  mutableEncoded(
    StructNoContext({
      ...Element.fields,
      div: Schema.String,
      status: NarrativeStatus,
    })
  )

export { NarrativeSchema as Schema }
