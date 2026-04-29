import { Pipeable, Schema } from 'effect'
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

export { TwoStepExternalSchema }
