import { Schema, pipe } from 'effect'
import type { Arbitrary, FastCheck } from 'effect'

import { Extension } from '../special-purpose/extension.ts'
import type { ExtensionEncoded } from '../special-purpose/extension.ts'

// Re-export so barrel consumers that previously got Extension from ./base
// Continue to resolve. Note: special-purpose/index.ts also re-exports
// Extension; the base/index.ts barrel should NOT re-export Extension to
// Avoid duplicate-export ambiguity in data-types/index.ts.

// ---------------------------------------------------------------------------
// Element
// ---------------------------------------------------------------------------

const fields = {
  extension: pipe(
    Schema.Array(Extension),
    Schema.annotations({
      arbitrary: (): Arbitrary.LazyArbitrary<readonly Extension[]> => (fc: typeof FastCheck) =>
        fc.constant([]),
    }),
    Schema.optionalWith({
      default: (): readonly Extension[] => [],
    })
  ),
} as const satisfies Schema.Struct.Fields

/**
 * The Schema field definitions produced by {@link Element} for a given domain
 * type: `resourceType` (defaulted literal), `id` (branded), and `extension`.
 *
 * @typeParam TResourceType - The literal domain type string
 */
type ElementFields<TResourceType extends string> = typeof fields & {
  resourceType: Schema.optionalWith<
    Schema.Literal<[TResourceType]>,
    { default: () => TResourceType }
  >
  id: Schema.optionalWith<
    Schema.UndefinedOr<Schema.brand<Schema.Schema<string, string>, `${TResourceType}/id`>>,
    { default: () => undefined }
  >
}

type ElementClass<Self, TResourceType extends string> = {
  readonly ResourceType: TResourceType
  readonly IdSchema: Schema.brand<Schema.Schema<string, string>, `${TResourceType}/id`>
} & Schema.Class<
  Self,
  ElementFields<TResourceType>,
  Schema.Struct.Encoded<ElementFields<TResourceType>>,
  Schema.Struct.Context<ElementFields<TResourceType>>,
  Schema.Struct.Constructor<ElementFields<TResourceType>>,
  object,
  object
>

/**
 * Factory that returns an Element mixin class for a given domain type.
 *
 * The returned class provides `resourceType` (a defaulted literal), an optional
 * branded `id`, and an `extension` array. It also exposes `ResourceType` and
 * `IdSchema` statics for downstream use.
 *
 * @typeParam TResourceType - The literal domain type string (e.g. `'Patient'`)
 * @param resourceType - The domain type string literal
 * @returns A Schema.Class mixin to compose via `.extend`
 *
 * @remarks
 * Both a factory function and a same-name type alias coexist via declaration
 * merging: `Element<'Patient'>` gives the decoded type while
 * `Element('Patient')` gives the mixin class.
 */
// oxlint-disable-next-line typescript-eslint/explicit-function-return-type -- Self type parameter is the locally-defined class; cannot be named externally
const Element = <TResourceType extends string>(resourceType: TResourceType) => {
  const idSchema = pipe(Schema.String, Schema.brand(`${resourceType}/id`))

  class ElementMixin extends Schema.Class<ElementMixin>('Element')({
    resourceType: Schema.Literal(resourceType).pipe(
      Schema.optionalWith({
        default: (): TResourceType => resourceType,
      })
    ),
    id: pipe(
      Schema.UndefinedOr(idSchema),
      Schema.annotations({
        arbitrary: (): Arbitrary.LazyArbitrary<undefined> => (fc: typeof FastCheck) =>
          fc.constant(undefined),
      }),
      Schema.optionalWith({ default: () => undefined })
    ),
    ...fields,
  }) {
    static readonly ResourceType = resourceType
    static readonly IdSchema = idSchema
  }

  return ElementMixin satisfies ElementClass<ElementMixin, TResourceType> as ElementClass<
    ElementMixin,
    TResourceType
  >
}

/** Decoded shape of an Element — the base building block for all FHIR types. */
interface Element<TResourceType extends string> {
  readonly resourceType: TResourceType
  readonly id?: string | undefined
  readonly extension: ReadonlyArray<Extension>
}

/** Encoded (wire-format) shape of an Element. */
interface ElementEncoded<TResourceType extends string> {
  readonly resourceType?: TResourceType | undefined
  readonly id?: string | undefined
  readonly extension?: readonly ExtensionEncoded[] | undefined
}

export { Element, type ElementEncoded, type ElementFields }
