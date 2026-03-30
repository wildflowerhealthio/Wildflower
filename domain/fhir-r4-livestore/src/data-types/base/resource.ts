import { Schema, pipe } from 'effect'
import type { Arbitrary, Brand, FastCheck } from 'effect'

import { AnnotateArrayWithArbitrary, PermissivePassthrough } from 'kitchen-sink/schema'

import { Code } from '../complex/code.ts'
import { Extension } from '../special-purpose/extension.ts'
import type { ExtensionEncoded } from '../special-purpose/extension.ts'
import { Narrative } from '../special-purpose/narrative.ts'
import { Meta } from './meta.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Decoded shape of a FHIR DomainResource — the base type for all clinical
 * resources. Includes meta, text, contained resources, and extensions.
 *
 * @typeParam TResourceType - The literal domain type string (e.g. `'Patient'`)
 */
interface Resource<TResourceType extends string> {
  readonly resourceType: TResourceType
  readonly id: (string & Brand.Brand<`${TResourceType}/id`>) | undefined
  readonly meta?: typeof Meta.Type
  readonly implicitRules?: URL
  readonly language?: typeof Code.Type
  readonly text?: typeof Narrative.Type
  readonly contained: ReadonlyArray<unknown>
  readonly extension: ReadonlyArray<Extension>
  readonly modifierExtension: ReadonlyArray<Extension>
}

/** Encoded (wire-format) shape of a Resource. */
interface ResourceEncoded<TResourceType extends string> {
  readonly resourceType?: TResourceType | undefined
  readonly id?: string | undefined
  readonly meta?: typeof Meta.Encoded | undefined
  readonly implicitRules?: string | undefined
  readonly language?: typeof Code.Encoded | undefined
  readonly text?: typeof Narrative.Encoded | undefined
  readonly contained?: readonly unknown[] | undefined
  readonly extension?: readonly ExtensionEncoded[] | undefined
  readonly modifierExtension?: readonly ExtensionEncoded[] | undefined
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const resourceFields = {
  /**
   * Metadata about the resource
   */
  meta: Schema.optional(Meta),
  /**
   * A set of rules under which this content was created
   */
  implicitRules: Schema.optional(Schema.URL),
  /**
   * Language of the resource content
   */
  language: Schema.optional(Code),
  /**
   * Text summary of the resource, for human interpretation
   */
  text: Schema.optional(Narrative),
  /**
   * Contained, inline Resources
   */
  // TODO: type contained resources when needed — Schema.Any passes anything through unvalidated
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

type ResourceFields<TResourceType extends string> = typeof resourceFields & {
  resourceType: Schema.optionalWith<
    Schema.Literal<[TResourceType]>,
    { default: () => TResourceType }
  >
  id: Schema.optionalWith<
    Schema.UndefinedOr<Schema.brand<Schema.Schema<string, string>, `${TResourceType}/id`>>,
    { default: () => undefined }
  >
}

type ResourceClass<Self, TResourceType extends string> = {
  readonly ResourceType: TResourceType
  readonly IdSchema: Schema.brand<Schema.Schema<string, string>, `${TResourceType}/id`>
} & Schema.Class<
  Self,
  ResourceFields<TResourceType>,
  Schema.Struct.Encoded<ResourceFields<TResourceType>>,
  Schema.Struct.Context<ResourceFields<TResourceType>>,
  Schema.Struct.Constructor<ResourceFields<TResourceType>>,
  object,
  object
>

/**
 * Factory that returns a Resource mixin class for a given domain type.
 *
 * The returned class includes all FHIR Resource fields: `meta`,
 * `text`, `contained`, `extension`, `modifierExtension`, plus `resourceType`
 * (a defaulted literal) and an optional branded `url`.
 *
 * @typeParam TResourceType - The literal domain type string (e.g. `'Patient'`)
 * @param resourceType - The domain type string literal
 * @returns A Schema.Class mixin to compose via `.extend`
 */
// oxlint-disable-next-line typescript-eslint/explicit-function-return-type -- Self type parameter is the locally-defined class; cannot be named externally
const Resource = <TResourceType extends string>(resourceType: TResourceType) => {
  const idSchema = pipe(Schema.String, Schema.brand(`${resourceType}/id`))

  class ResourceMixin extends Schema.Class<ResourceMixin>('Resource')({
    ...resourceFields,
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
  }) {
    static readonly ResourceType = resourceType
    static readonly IdSchema: Schema.brand<Schema.Schema<string, string>, `${TResourceType}/id`> =
      idSchema
  }
  return ResourceMixin satisfies ResourceClass<ResourceMixin, TResourceType> as ResourceClass<
    ResourceMixin,
    TResourceType
  >
}

export { Resource, type ResourceEncoded }
