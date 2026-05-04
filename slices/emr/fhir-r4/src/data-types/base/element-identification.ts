import { Effect, Schema } from 'effect'

import { domainIdentification } from '../url-identification.ts'

export const ElementIdentification = <TDomainType extends string>(
  resourceType: TDomainType
): Schema.Schema<
  { readonly id: null | string; readonly resourceType: TDomainType },
  { id?: string | undefined; readonly resourceType: TDomainType },
  never
> =>
  Schema.transformOrFail(
    Schema.mutable(
      Schema.Struct({
        resourceType: Schema.Literal(resourceType),
        id: Schema.optional(Schema.String),
      })
    ),
    domainIdentification(resourceType),
    {
      decode: (fhirType) =>
        Effect.sync(function () {
          return {
            id: fhirType.id,
            resourceType,
          }
        }),
      encode: (source) =>
        Effect.sync(function () {
          return { id: source.id, resourceType }
        }),
      strict: true,
    }
  )
