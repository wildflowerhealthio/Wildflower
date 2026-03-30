import { Schema, pipe } from 'effect'
import type { Arbitrary, FastCheck } from 'effect'

import { makeCloneWith } from 'kitchen-sink/schema'
import { AllDatatypeNames, DatatypeChoice } from '../datatype.ts'

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

const ExtensionKey = 'Extension' as const
type ExtensionKey = typeof ExtensionKey

const extensionIdSchema = pipe(Schema.String, Schema.brand(`${ExtensionKey}/id`))

const ValueChoice = DatatypeChoice(AllDatatypeNames)

/** Encoded (wire-format) shape of an {@link Extension}. */
export interface ExtensionEncoded {
  readonly resourceType?: ExtensionKey | undefined
  readonly id?: string | undefined
  readonly extension?: readonly ExtensionEncoded[] | undefined
  readonly url: string
  readonly value?: typeof ValueChoice.Encoded | undefined
}

const extensionFields = {
  id: Schema.optional(extensionIdSchema),
  resourceType: Schema.Literal(ExtensionKey).pipe(
    Schema.optionalWith({
      default: (): ExtensionKey => ExtensionKey,
    })
  ),
  extension: pipe(
    Schema.Array(Schema.suspend((): Schema.Schema<Extension, ExtensionEncoded> => Extension)),
    Schema.annotations({
      arbitrary: (): Arbitrary.LazyArbitrary<readonly Extension[]> => (fc: typeof FastCheck) =>
        fc.constant([]),
    }),
    Schema.optionalWith({
      default: (): ReadonlyArray<Extension> => [],
    })
  ),
  url: Schema.String,
  value: pipe(
    Schema.UndefinedOr(ValueChoice),
    Schema.annotations({
      arbitrary: (): Arbitrary.LazyArbitrary<undefined> => (fc: typeof FastCheck) =>
        fc.constant(undefined),
    }),
    Schema.optionalWith({ default: () => undefined })
  ),
} as const satisfies Schema.Struct.Fields

/**
 * FHIR R4 Extension — carries additional data on any element via a
 * `definitionUrl` and a polymorphic value choice. Extensions can
 * nest recursively via the `extension` array.
 */
export class Extension extends Schema.Class<Extension>('Extension')(extensionFields) {
  static readonly ResourceType = ExtensionKey
  static readonly IdSchema = extensionIdSchema
  static readonly ValueChoice = ValueChoice

  readonly cloneWith = makeCloneWith(Extension, this)
}
