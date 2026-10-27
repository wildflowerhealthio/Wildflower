import { HttpApiEndpoint, HttpApiError, HttpApiGroup } from '@effect/platform'
import { Data, Schema } from 'effect'

import * as Bundle from '../data-types/resources/bundle.ts'

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
 */
/**
 * A Bundle the server refused whole: the HTTP `status` it answered, as
 * `"NNN Text"` like an entry's echoed `response.status`, and the
 * OperationOutcome it answered with.
 *
 * @remarks
 * FHIR R4 § 3.2.6: a transaction that fails is answered with an error for
 * the Bundle and an OperationOutcome saying why, not a per-entry response.
 * HFS does so at the status of the failure (`400` for a refused entry, `412`
 * for a failed condition, `500` for a rollback, `501` for a backend without
 * transactions, `504` for a timeout).
 */
class BundleRefused extends Data.TaggedError('BundleRefused')<{
  readonly status: string
  readonly outcome: Bundle.OperationOutcomeType
}> {}

/**
 * The refusal answered at HTTP `code`: the response body, an
 * OperationOutcome, read as a {@link BundleRefused} carrying `code` and its
 * `reason` phrase, since the status is the response's, not the body's.
 */
const refusedAt = (
  code: number,
  reason: string
): Schema.Schema<BundleRefused, typeof Bundle.OperationOutcomeSchema.Encoded> =>
  Schema.transform(
    Bundle.OperationOutcomeSchema,
    Schema.declare((value: unknown): value is BundleRefused => value instanceof BundleRefused),
    {
      strict: true,
      decode: (outcome) => new BundleRefused({ status: `${code} ${reason}`, outcome }),
      encode: (refused) => refused.outcome,
    }
  )

const httpApiGroup = HttpApiGroup.make('Bundle').add(
  HttpApiEndpoint.post('Submit', `/`)
    .setPayload(Bundle.Schema(Schema.Any))
    .addSuccess(Bundle.Schema(Schema.Any))
    .addError(refusedAt(400, 'Bad Request'), { status: 400 })
    .addError(refusedAt(404, 'Not Found'), { status: 404 })
    .addError(refusedAt(409, 'Conflict'), { status: 409 })
    .addError(refusedAt(412, 'Precondition Failed'), { status: 412 })
    .addError(refusedAt(422, 'Unprocessable Entity'), { status: 422 })
    .addError(refusedAt(500, 'Internal Server Error'), { status: 500 })
    .addError(refusedAt(501, 'Not Implemented'), { status: 501 })
    .addError(refusedAt(504, 'Gateway Timeout'), { status: 504 })
    .addError(HttpApiError.ServiceUnavailable)
    .addError(HttpApiError.Forbidden)
)

export { httpApiGroup }
