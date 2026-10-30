import { HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema } from '@effect/platform'
import { Data, Schema } from 'effect'

import * as Bundle from '../data-types/resources/bundle.ts'

/** The server's `400` answer to a submitted Bundle, its `body` as text. */
class BundleBadRequest extends Data.TaggedError('BundleBadRequest')<{
  readonly body: string
}> {}

/**
 * Any `400` body, read as text into a {@link BundleBadRequest}.
 *
 * @remarks
 * Every `HttpApi` declares Effect's own `HttpApiDecodeError` at `400`, so the
 * client decodes a `400` body as that error, and a FHIR server's body fails
 * the decode with no status. As a second member at `400`, this one takes any
 * body the first does not.
 */
const badRequestAsText = HttpApiSchema.withEncoding(
  Schema.transform(
    Schema.String,
    Schema.declare(
      (value: unknown): value is BundleBadRequest => value instanceof BundleBadRequest
    ),
    {
      strict: true,
      decode: (body) => new BundleBadRequest({ body }),
      encode: (badRequest) => badRequest.body,
    }
  ),
  { kind: 'Text' }
)

/**
 * The FHIR `POST /` endpoint: submit a `Bundle{ type: 'batch' | 'transaction' }`
 * against the FHIR base and get back a
 * `Bundle{ type: 'batch-response' | 'transaction-response' }` with a per-entry
 * `response.status` (and, for reads, a `resource`).
 *
 * @remarks
 * A *group of its own*, at the FHIR root — not another per-resource endpoint.
 * Every domain-resource group carries its own `/${resourceType}` prefix; this
 * one carries none, so the endpoint lives at bare `/`, the FHIR base (see the
 * "The `HttpApi` is base-relative" entry in the Client Capabilities Reference).
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
 * loose entry-body type never reaches the caller as truth. The same looseness
 * holds on the way out: `Schema.Any` passes an entry's `resource` through as
 * it is, so a caller submitting resources encodes them itself
 * (`persistBatchBundle` does) — a decoded resource is not its wire form.
 *
 * The server (HFS) processes the bundle and answers with the response bundle;
 * per-entry statuses (`"201 Created"`, `"200 OK"`, `"404 Not Found"`) are what
 * a caller reads to reconcile each entry, both for existence pre-fetch (a `404`
 * means the id is not present) and for the write path (a non-2xx means that
 * entry did not write).
 *
 * A Bundle the server refuses whole (FHIR R4 § 3.2.6: an error status and an
 * OperationOutcome for the Bundle rather than a per-entry response; HFS
 * answers `400`, `412`, `500`, `501` or `504`) is deliberately not a declared
 * error. A declared error's body is decoded by the client, and a body that
 * does not decode fails as a `ParseError` carrying no status. Left undeclared,
 * every non-2xx reaches the caller as a `ResponseError` holding the response,
 * which the clients read status first, then the body as an OperationOutcome
 * when it is one. `400` is the exception, since every `HttpApi` already
 * declares one: it arrives as a {@link BundleBadRequest} carrying the body,
 * read the same way. `Forbidden` and `ServiceUnavailable` are declared because
 * they carry no body to read.
 */
const httpApiGroup = HttpApiGroup.make('Bundle').add(
  HttpApiEndpoint.post('Submit', `/`)
    .setPayload(Bundle.Schema(Schema.Any))
    .addSuccess(Bundle.Schema(Schema.Any))
    .addError(badRequestAsText, { status: 400 })
    .addError(HttpApiError.ServiceUnavailable)
    .addError(HttpApiError.Forbidden)
)

export { httpApiGroup }
