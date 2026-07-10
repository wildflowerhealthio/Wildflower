import { HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema } from '@effect/platform'
import { Option, Schema, SchemaAST } from 'effect'

import { withMandatoryId } from '../data-types/index.ts'
import * as Bundle from '../data-types/resources/bundle.ts'

const NumFromStr = Schema.NumberFromString.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0))

const EverythingParams = Schema.Struct({
  _count: Schema.optional(NumFromStr.pipe(Schema.between(0, 1000))),
})

/**
 * The `$everything` operation endpoint for `resourceType`. Deliberately not
 * part of {@link buildDomainResourceHttpApiGroup}: the server only implements
 * the operation for `Patient`, so each resource that has it opts in
 * explicitly. The path carries its own `/${resourceType}` segment because
 * `HttpApiGroup.prefix` (applied inside the builder) only rewrites endpoints
 * already added at that point.
 */
// oxlint-disable-next-line typescript-eslint/explicit-function-return-type
function buildEverythingEndpoint(resourceType: string) {
  return HttpApiEndpoint.get('Everything', `/${resourceType}/:id/$everything`)
    .setPath(Schema.Struct({ id: Schema.String }))
    .setUrlParams(EverythingParams)
    .addSuccess(Bundle.Schema(Schema.Any))
    .addError(HttpApiError.NotFound)
    .addError(HttpApiError.ServiceUnavailable)
    .addError(HttpApiError.Forbidden)
}

// oxlint-disable-next-line typescript-eslint/explicit-function-return-type
function buildDomainResourceHttpApiGroup<
  RT extends string,
  StoreType extends { id: string | null },
  FhirEncoded extends { id?: string | undefined },
  SearchParams,
>(
  resourceType: RT,
  fhirSchema: Schema.Schema<StoreType, FhirEncoded, never>,
  searchParamsSchema: Schema.Schema<SearchParams, Record<string, string | undefined>>
) {
  const base = withMandatoryId(fhirSchema)

  const fhirSchemaWithId = Option.match(SchemaAST.getJSONSchemaAnnotation(fhirSchema.ast), {
    onNone: () => base,
    onSome: (jsonSchema) => base.annotations({ jsonSchema }),
  })

  const formPayloadSchema = searchParamsSchema.pipe(
    HttpApiSchema.withEncoding({ kind: 'UrlParams' })
  )

  return HttpApiGroup.make(resourceType)
    .add(
      HttpApiEndpoint.get('SearchByGet', `/`)
        .setUrlParams(searchParamsSchema)
        .addSuccess(Bundle.Schema(fhirSchemaWithId))
        .addError(HttpApiError.ServiceUnavailable)
        .addError(HttpApiError.Forbidden)
    )
    .add(
      HttpApiEndpoint.post('Create', `/`)
        .addSuccess(fhirSchemaWithId)
        .setPayload(fhirSchema)
        .addError(HttpApiError.ServiceUnavailable)
    )
    .add(
      HttpApiEndpoint.get('GetById', `/:id`)
        .setPath(Schema.Struct({ id: Schema.String }))
        .addSuccess(fhirSchemaWithId)
        .addError(HttpApiError.NotFound)
        .addError(HttpApiError.ServiceUnavailable)
    )
    .add(
      HttpApiEndpoint.put('Update', `/:id`)
        .setPath(Schema.Struct({ id: Schema.String }))
        .addSuccess(fhirSchemaWithId)
        .setPayload(fhirSchemaWithId)
        .addError(HttpApiError.ServiceUnavailable)
    )
    .add(
      HttpApiEndpoint.post('Search', `/_search`)
        .setPayload(formPayloadSchema)
        .addSuccess(Bundle.Schema(fhirSchemaWithId))
        .addError(HttpApiError.ServiceUnavailable)
        .addError(HttpApiError.Forbidden)
    )
    .prefix(`/${resourceType}`)
}

export { buildDomainResourceHttpApiGroup, buildEverythingEndpoint }
