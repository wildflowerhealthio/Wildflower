import { type Arbitrary, type FastCheck, Schema, pipe } from 'effect'

import { suspendWithShallowJson } from 'kitchen-sink/schema'
import * as ChoiceElementSet from '../choice-element-set.ts'
import * as Datatype from '../datatype.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const ResourceType = 'Extension' as const
type ResourceType = typeof ResourceType

/**
 * Flat `Schema.Struct` of `value{Capitalize<name>}` fields, one per FHIR R4
 * choice-element variant an Extension can carry (`value[x]`). Each field is
 * `Schema.NullOr<...>`; mutual exclusion is not enforced at the schema level.
 */
const valueChoiceSchemaFields = ChoiceElementSet.SchemaFields('value', Datatype.names)
const emptyValueChoice = ChoiceElementSet.empty('value', Datatype.names)
// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

interface ExtensionType extends Schema.Struct.Type<typeof valueChoiceSchemaFields> {
  readonly id: string | null
  readonly extension: readonly ExtensionType[]
  readonly url: string
}

interface ExtensionEncoded extends Schema.Struct.Encoded<typeof valueChoiceSchemaFields> {
  readonly id: string | null
  readonly extension: readonly ExtensionEncoded[]
  readonly url: string
}

/**
 * FHIR R4 Extension — carries additional data on any element via a
 * `definitionUrl` and a polymorphic value choice. Extensions can
 * nest recursively via the `extension` array.
 */
const ExtensionSchema: Schema.Schema<ExtensionType, ExtensionEncoded, never> = Schema.Struct({
  id: Schema.NullOr(Schema.String),
  extension: pipe(
    Schema.Array(
      suspendWithShallowJson(() => ExtensionSchema, 'Extension').annotations({
        identifier: 'extension',
      })
    ),
    // Override `Arbitrary.make(...)` to always emit `[]`. Nested extensions
    // multiply the size of every Patient/Observation property test (each
    // child carries the full ~50-field value[x] choice, the cycle through
    // Reference/Identifier, etc.). Recursion through `extension` is exercised
    // explicitly by `cycles.test.ts`; everywhere else, an empty array keeps
    // arbitrary generation tractable.
    Schema.annotations({
      arbitrary:
        (): Arbitrary.LazyArbitrary<readonly Schema.Schema.Type<typeof ExtensionSchema>[]> =>
        (fc: typeof FastCheck) =>
          fc.constant([]),
    })
  ).annotations({ identifier: 'extension' }),
  url: Schema.String,
  ...valueChoiceSchemaFields,
})

export {
  ResourceType,
  ExtensionSchema as Schema,
  valueChoiceSchemaFields as ValueChoice,
  emptyValueChoice,
}
export type { ExtensionType, ExtensionEncoded, ExtensionType as Type, ExtensionEncoded as Encoded }
