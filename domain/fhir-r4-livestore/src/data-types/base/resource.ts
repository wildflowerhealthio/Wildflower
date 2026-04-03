import { Schema, pipe } from 'effect'
import type { Arbitrary, Brand, FastCheck } from 'effect'

import { Code } from '../complex/code.ts'
import { Meta } from './meta.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Decoded shape of a FHIR Resource — the base type for all resources.
 * Includes only the four fields defined on FHIR R4 Resource:
 * `id`, `meta`, `implicitRules`, `language`.
 *
 * @typeParam TResourceType - The literal domain type string (e.g. `'Patient'`)
 */
interface Resource<TResourceType extends string> {
  readonly resourceType: TResourceType
  readonly id: (string & Brand.Brand<`${TResourceType}/id`>) | undefined
  readonly meta?: typeof Meta.Type
  readonly implicitRules?: URL
  readonly language?: typeof Code.Type
}

/** Encoded (wire-format) shape of a Resource. */
interface ResourceEncoded<TResourceType extends string> {
  readonly resourceType?: TResourceType | undefined
  readonly id?: string | undefined
  readonly meta?: typeof Meta.Encoded | undefined
  readonly implicitRules?: string | undefined
  readonly language?: typeof Code.Encoded | undefined
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const resourceFields = {
  /**
   * Metadata about the resource
   */
  meta: Schema.UndefinedOr(Meta).pipe(Schema.optionalWith({ default: () => undefined })),
  /**
   * A set of rules under which this content was created
   */
  implicitRules: Schema.UndefinedOr(Schema.URL).pipe(
    Schema.optionalWith({ default: () => undefined })
  ),
  /**
   * Language of the resource content
   */
  language: Schema.UndefinedOr(Code).pipe(Schema.optionalWith({ default: () => undefined })),
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
 * The returned class includes the FHIR R4 Resource fields: `meta`,
 * `implicitRules`, `language`, plus `resourceType` (a defaulted literal)
 * and an optional branded `id`.
 *
 * For resources that extend DomainResource (most clinical resources), use
 * the {@link DomainResource} factory instead, which adds `text`, `contained`,
 * `extension`, and `modifierExtension`.
 *
 * @typeParam TResourceType - The literal domain type string (e.g. `'Binary'`)
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

export { Resource, type ResourceEncoded, type ResourceFields }
