import { type Arbitrary, type FastCheck, Schema } from 'effect'

import { mutableEncoded, OrNullAsOptional, StructNoContext } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import {
  choiceElementSetExclusive,
  choiceElementSetPassthroughFields,
} from '../base/choice-element-passthrough-fields.ts'
import * as ChoiceElementSet from '../base/choice-element-set.ts'
import * as Datatype from '../base/datatype.ts'

const valueChoiceFields = choiceElementSetPassthroughFields('value', Datatype.names)

/** All-`null` `value[x]` slots — spread into a decoded Extension literal. */
const emptyValueChoice = ChoiceElementSet.empty('value', Datatype.names)

/**
 * Decoded shape of {@link ExtensionSchema}. Written out explicitly (rather
 * than inferred) because the schema is recursive through the nested
 * `extension` array — TypeScript cannot infer a type for a self-referential
 * schema constant.
 */
interface ExtensionType extends Schema.Struct.Type<typeof valueChoiceFields> {
  readonly id: string | null
  readonly extension: readonly ExtensionType[]
  readonly url: string
}

const ExtensionSchema: Schema.Schema<ExtensionType, FhirR4.Extension, never> = mutableEncoded(
  StructNoContext({
    id: OrNullAsOptional(Schema.String),
    // Override `Arbitrary.make(...)` to always emit `[]`. Nested extensions
    // multiply the size of every resource property test (each child carries
    // the full ~50-field value[x] choice). Recursion through `extension` is
    // exercised by explicit fixtures; everywhere else, an empty array keeps
    // arbitrary generation tractable.
    extension: Schema.optionalWith(
      mutableEncoded(
        Schema.Array(Schema.suspend(() => ExtensionSchema)).annotations({
          arbitrary:
            (): Arbitrary.LazyArbitrary<readonly ExtensionType[]> => (fc: typeof FastCheck) =>
              fc.constant([]),
        })
      ),
      { default: (): readonly ExtensionType[] => [] }
    ),
    url: Schema.String,
    ...valueChoiceFields,
  })
).pipe(choiceElementSetExclusive('value', Datatype.names))

export { ExtensionSchema as Schema, emptyValueChoice, type ExtensionType as Type }
