import { type Arbitrary, type FastCheck, Schema as ES, pipe } from 'effect'

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

interface ExtensionType extends ES.Struct.Type<typeof ValueChoice.fields> {
  readonly id: string | null
  readonly extension: readonly ExtensionType[]
  readonly url: string
}

interface ExtensionEncoded extends ES.Struct.Encoded<typeof ValueChoice.fields> {
  readonly id: string | null
  readonly extension: readonly ExtensionEncoded[]
  readonly url: string
}

/**
 * FHIR R4 Extension — carries additional data on any element via a
 * `definitionUrl` and a polymorphic value choice. Extensions can
 * nest recursively via the `extension` array.
 */
const Schema: ES.Schema<ExtensionType, ExtensionEncoded, never> = ES.Struct({
  id: ES.NullOr(ES.String),
  extension: pipe(
    ES.Array(
      ES.suspend(() => Schema).annotations({
        identifier: 'extension',
      })
    ),
    ES.annotations({
      arbitrary:
        (): Arbitrary.LazyArbitrary<readonly ES.Schema.Type<typeof Schema>[]> =>
        (fc: typeof FastCheck) =>
          fc.constant([]),
    })
  ).annotations({ identifier: 'extension' }),
  url: ES.String,
  ...ValueChoice.fields,
})

export { ResourceType, Schema, ValueChoice }
export type { ExtensionType, ExtensionEncoded, ExtensionType as Type, ExtensionEncoded as Encoded }
