import { Schema, pipe } from 'effect'
import type { Arbitrary, FastCheck } from 'effect'

import { AnnotateArrayWithArbitrary, PermissivePassthrough } from 'kitchen-sink/schema'

import { Extension } from '../special-purpose/extension.ts'
import type { ExtensionEncoded } from '../special-purpose/extension.ts'
import { Narrative } from '../special-purpose/narrative.ts'
import { Resource } from './resource.ts'
import type { ResourceEncoded, ResourceFields } from './resource.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Decoded shape of a FHIR DomainResource — extends {@link Resource} with
 * `text`, `contained`, `extension`, and `modifierExtension`.
 * Used as the base for all clinical resources (e.g. Patient, Observation).
 *
 * @typeParam TResourceType - The literal domain type string (e.g. `'Patient'`)
 */
interface DomainResource<TResourceType extends string> extends Resource<TResourceType> {
  readonly text?: typeof Narrative.Type
  readonly contained: ReadonlyArray<unknown>
  readonly extension: ReadonlyArray<Extension>
  readonly modifierExtension: ReadonlyArray<Extension>
}

const fields = {
  /**
   * Text summary of the resource, for human interpretation
   */
  text: Schema.UndefinedOr(Narrative).pipe(Schema.optionalWith({ default: () => undefined })),
  /**
   * Contained, inline Resources
   */
  // Eventually, type the contained resources
  // Schema.Any passes anything through unvalidated
  contained: Schema.Array(PermissivePassthrough).pipe(
    AnnotateArrayWithArbitrary({ maxLength: 0 }),
    Schema.optionalWith({
      default: (): readonly unknown[] => [],
    })
  ),
  /**
   * Additional content defined by implementations
   */
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
  /**
   * Extensions that cannot be ignored
   */
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

/** Encoded (wire-format) shape of a DomainResource. */
type DomainResourceEncoded<TResourceType extends string> = ResourceEncoded<TResourceType> & {
  readonly text?: typeof Narrative.Encoded | undefined
  readonly contained?: readonly unknown[] | undefined
  readonly extension?: readonly ExtensionEncoded[] | undefined
  readonly modifierExtension?: readonly ExtensionEncoded[] | undefined
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

type DomainResourceFields<TResourceType extends string> = ResourceFields<TResourceType> &
  typeof fields

type DomainResourceClass<Self, TResourceType extends string> = {
  readonly ResourceType: TResourceType
  readonly IdSchema: Schema.brand<Schema.Schema<string, string>, `${TResourceType}/id`>
} & Schema.Class<
  Self,
  DomainResourceFields<TResourceType>,
  Schema.Struct.Encoded<DomainResourceFields<TResourceType>>,
  Schema.Struct.Context<DomainResourceFields<TResourceType>>,
  Schema.Struct.Constructor<DomainResourceFields<TResourceType>>,
  object,
  object
>

/**
 * Factory that returns a DomainResource mixin class for a given domain type.
 *
 * Extends {@link Resource} with `text`, `contained`, `extension`, and
 * `modifierExtension`. Used for all clinical FHIR resources.
 *
 * Resources that extend Resource directly (e.g. Binary, Bundle) should use
 * the {@link Resource} factory instead.
 *
 * @typeParam TResourceType - The literal domain type string (e.g. `'Patient'`)
 * @param resourceType - The domain type string literal
 * @returns A Schema.Class mixin to compose via `.extend`
 */
// oxlint-disable-next-line typescript-eslint/explicit-function-return-type -- Self type parameter is the locally-defined class; cannot be named externally
const DomainResource = <TResourceType extends string>(resourceType: TResourceType) => {
  const ResourceBase = Resource(resourceType)
  class DomainResourceMixin extends ResourceBase.extend<DomainResourceMixin>('DomainResource')(
    fields
  ) {
    static readonly ResourceType = ResourceBase.ResourceType
    static readonly IdSchema = ResourceBase.IdSchema
  }
  return DomainResourceMixin satisfies DomainResourceClass<
    DomainResourceMixin,
    TResourceType
  > as DomainResourceClass<DomainResourceMixin, TResourceType>
}

export { DomainResource, type DomainResourceEncoded }
