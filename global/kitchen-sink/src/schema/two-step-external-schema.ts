import { Pipeable, Schema, pipe } from 'effect'
import type * as AST from 'effect/SchemaAST'

/**
 * A schema that transforms from an External type to a Domain type via an
 * intermediate Encoded type. Implements `Schema.Schema<Domain, External, R>`
 * so consumers can use it directly as a schema.
 *
 * The two-step construction is:
 *   `External --[EncodedFromExternal]--> DomainEncoded --[DomainFromEncoded]--> Domain`
 *
 * The composed schema (`External → Domain`) is what the `Schema` interface exposes.
 *
 * @typeParam Domain - The decoded domain type (the `Type` side)
 * @typeParam DomainEncoded - The intermediate encoded representation understood by `DomainFromEncoded`
 * @typeParam External - The raw external representation (e.g. a Firebase or FHIR payload)
 * @typeParam R - The Effect context/environment required for decoding
 */
class TwoStepExternalSchema<Domain, DomainEncoded, External, R = never>
  extends Pipeable.Class()
  implements Schema.Schema<Domain, External, R>
{
  private readonly composed: Schema.Schema<Domain, External, R>

  readonly [Schema.TypeId]: Schema.Schema<Domain, External, R>[typeof Schema.TypeId]

  get Type(): Domain {
    return this.composed.Type
  }

  get Encoded(): External {
    return this.composed.Encoded
  }

  get Context(): R {
    return this.composed.Context
  }

  get ast(): AST.AST {
    return this.composed.ast
  }

  annotations(
    annotations: Schema.Annotations.GenericSchema<Domain>
  ): Schema.Schema<Domain, External, R> {
    return this.composed.annotations(annotations)
  }

  constructor(
    DomainFromEncoded: Schema.Schema<Domain, DomainEncoded>,
    public readonly EncodedFromExternal: Schema.Schema<DomainEncoded, External, R>
  ) {
    super()
    this.composed = Schema.compose(this.EncodedFromExternal, DomainFromEncoded)
    this[Schema.TypeId] = this.composed[Schema.TypeId]
  }
}

/**
 * A schema that transforms from an Integration-encoded representation to a
 * Domain type through two intermediate steps.
 *
 * The three-step pipeline is:
 *   `IntegrationEncoded --[IntegrationFromEncoded]--> IntegrationType`
 *   `--[DomainEncodedFromExternalType]--> DomainEncoded`
 *   `--[DomainFromEncoded]--> DomainType`
 *
 * @typeParam DomainType - The fully decoded domain type (the `Type` side)
 * @typeParam DomainEncoded - The intermediate representation expected by `DomainFromEncoded`
 * @typeParam IntegrationType - The integration layer's decoded type
 * @typeParam IntegrationEncoded - The raw external payload (the `Encoded` side)
 * @typeParam R - The Effect context/environment required for decoding
 */
class ThreeStepExternalSchema<
  DomainType,
  DomainEncoded,
  IntegrationType,
  IntegrationEncoded,
  R = never,
>
  extends Pipeable.Class()
  implements Schema.Schema<DomainType, IntegrationEncoded, R>
{
  private readonly composed: Schema.Schema<DomainType, IntegrationEncoded, R>

  readonly [Schema.TypeId]: Schema.Schema<DomainType, IntegrationEncoded, R>[typeof Schema.TypeId]

  get Type(): DomainType {
    return this.composed.Type
  }

  get Encoded(): IntegrationEncoded {
    return this.composed.Encoded
  }

  get Context(): R {
    return this.composed.Context
  }

  get ast(): AST.AST {
    return this.composed.ast
  }

  annotations(
    annotations: Schema.Annotations.GenericSchema<DomainType>
  ): Schema.Schema<DomainType, IntegrationEncoded, R> {
    return this.composed.annotations(annotations)
  }

  constructor(
    private DomainFromEncoded: Schema.Schema<DomainType, DomainEncoded>,
    private IntegrationFromEncoded: Schema.Schema<IntegrationType, IntegrationEncoded, R>,
    public readonly DomainEncodedFromExternalType: Schema.Schema<DomainEncoded, IntegrationType, R>
  ) {
    super()
    this.composed = pipe(
      this.IntegrationFromEncoded,
      Schema.compose(this.DomainEncodedFromExternalType),
      Schema.compose(this.DomainFromEncoded)
    )

    this[Schema.TypeId] = this.composed[Schema.TypeId]
  }
}

export { TwoStepExternalSchema, ThreeStepExternalSchema }
