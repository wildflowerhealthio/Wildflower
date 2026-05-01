import { type Arbitrary, type FastCheck, Schema, pipe } from 'effect'

import * as DatatypeChoice from '../datatype-choice.ts'
import { AllDatatypeNames } from '../datatype.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const ResourceType = 'Extension' as const
type ResourceType = typeof ResourceType

/**
 * Tagged union of every FHIR R4 choice-element value variant an Extension
 * can carry (`value[x]`).
 */
const ValueChoice = DatatypeChoice.DatatypeChoice('value', AllDatatypeNames)

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

interface ExtensionType extends Schema.Struct.Type<typeof ValueChoice.fields> {
  readonly id: string | null
  readonly extension: readonly ExtensionType[]
  readonly url: string
}

interface ExtensionEncoded extends Schema.Struct.Encoded<typeof ValueChoice.fields> {
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
      Schema.suspend(() => ExtensionSchema).annotations({
        identifier: 'extension',
      })
    ),
    Schema.annotations({
      arbitrary:
        (): Arbitrary.LazyArbitrary<readonly Schema.Schema.Type<typeof ExtensionSchema>[]> =>
        (fc: typeof FastCheck) =>
          fc.constant([]),
    })
  ).annotations({ identifier: 'extension' }),
  url: Schema.String,
  ...ValueChoice.fields,
})

export { ResourceType, ExtensionSchema as Schema, ValueChoice }
export type { ExtensionType, ExtensionEncoded, ExtensionType as Type, ExtensionEncoded as Encoded }
