import { HttpApiEndpoint, HttpApiError, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'

import * as Bundle from '../data-types/resources/bundle.ts'

/**
 * The FHIR `POST /` endpoint: submit a `Bundle{ type: 'batch' | 'transaction' }`
 * against the FHIR base and get back a `Bundle{ type: 'batch-response' |
 * 'transaction-response' }` with a per-entry `response.status` (and, for reads,
 * a `resource`).
 *
 * @remarks
 * A *group of its own*, at the FHIR root — not another per-resource endpoint.
 * Every domain-resource group carries its own `/${resourceType}` prefix; this
 * one carries none, so the endpoint lives at bare `/` (the mount prefix
 * `/fhir-r4` is applied by the host — see the "The `HttpApi` is base-relative"
 * entry in the Client Capabilities Reference).
 *
 * The entry `resource` type on this endpoint is deliberately `Schema.Any`
 * rather than {@link Bundle.Schema} parameterised over the discriminated
 * `FhirResource` union. That union is large enough that instantiating a
 * Bundle over it explodes the inferred client type well past TS's serialize
 * limit ("inferred type … exceeds the maximum length" on
 * `FhirR4ResourcesHttpApiClient`). Every caller in this slice's clients
 * (`persistBatchBundle`, `classifyAgainstServer`) inspects the response by
 * `entry.response.status` and decodes any returned `entry.resource` through
 * {@link FhirResourceSchema} separately when it needs the typed shape, so the
 * loose entry-body type never reaches the caller as truth.
 *
 * The server (HFS) processes the bundle and answers with the response bundle;
 * per-entry statuses (`"201 Created"`, `"200 OK"`, `"404 Not Found"`) are what
 * a caller reads to reconcile each entry, both for existence pre-fetch (a `404`
 * means the id is not present) and for the write path (a non-2xx means that
 * entry did not write).
 */
const httpApiGroup = HttpApiGroup.make('Bundle').add(
  HttpApiEndpoint.post('Submit', `/`)
    .setPayload(Bundle.Schema(Schema.Any))
    .addSuccess(Bundle.Schema(Schema.Any))
    .addError(HttpApiError.ServiceUnavailable)
    .addError(HttpApiError.Forbidden)
)

export { httpApiGroup }
