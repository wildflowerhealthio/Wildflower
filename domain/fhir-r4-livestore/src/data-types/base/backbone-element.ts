import { Schema, pipe } from 'effect'
import type { Arbitrary, FastCheck } from 'effect'

import { Extension } from '../special-purpose/extension.ts'
import type { ExtensionEncoded } from '../special-purpose/extension.ts'
import { Element } from './element.ts'
import type { ElementEncoded, ElementFields } from './element.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Decoded shape of a BackboneElement — extends {@link Element} with
 * `modifierExtension`. Used for nested structures within resources
 * (e.g. `Patient.contact`, `Encounter.participant`).
 *
 * @typeParam TResourceType - The literal domain type string
 */
interface BackboneElement<TResourceType extends string> extends Element<TResourceType> {
  readonly modifierExtension: readonly Extension[]
}

const fields = {
  modifierExtension: pipe(
    Schema.Array(Schema.suspend((): Schema.Schema<Extension, ExtensionEncoded> => Extension)),
    Schema.annotations({
      arbitrary: (): Arbitrary.LazyArbitrary<readonly Extension[]> => (fc: typeof FastCheck) =>
        fc.constant([]),
    }),
    Schema.optionalWith({
      default: (): readonly Extension[] => [],
    })
  ),
} as const satisfies Schema.Struct.Fields

/** Encoded (wire-format) shape of a BackboneElement. */
type BackboneElementEncoded<TResourceType extends string> = ElementEncoded<TResourceType> & {
  readonly modifierExtension?: readonly ExtensionEncoded[] | undefined
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

type BackboneElementFields<TResourceType extends string> = ElementFields<TResourceType> &
  typeof fields

type BackboneElementClass<Self, TResourceType extends string> = {
  readonly ResourceType: TResourceType
  readonly IdSchema: Schema.brand<Schema.Schema<string, string>, `${TResourceType}/id`>
} & Schema.Class<
  Self,
  BackboneElementFields<TResourceType>,
  Schema.Struct.Encoded<BackboneElementFields<TResourceType>>,
  Schema.Struct.Context<BackboneElementFields<TResourceType>>,
  Schema.Struct.Constructor<BackboneElementFields<TResourceType>>,
  object,
  object
>

/**
 * Factory that returns a BackboneElement mixin class for a given domain type.
 *
 * Extends {@link Element} with a `modifierExtension` array. Used for nested
 * structures within FHIR resources.
 *
 * @typeParam TResourceType - The literal domain type string
 * @param resourceType - The domain type string literal
 * @returns A Schema.Class mixin to compose via `.extend`
 */
// oxlint-disable-next-line typescript-eslint/explicit-function-return-type -- Self type parameter is the locally-defined class; cannot be named externally
const BackboneElement = <TResourceType extends string>(resourceType: TResourceType) => {
  const ElementBase = Element(resourceType)
  class BackboneElementMixin extends ElementBase.extend<BackboneElementMixin>('BackboneElement')(
    fields
  ) {
    static readonly ResourceType = ElementBase.ResourceType
    static readonly IdSchema = ElementBase.IdSchema
  }
  return BackboneElementMixin satisfies BackboneElementClass<
    BackboneElementMixin,
    TResourceType
  > as BackboneElementClass<BackboneElementMixin, TResourceType>
}

export { BackboneElement, type BackboneElementEncoded }
