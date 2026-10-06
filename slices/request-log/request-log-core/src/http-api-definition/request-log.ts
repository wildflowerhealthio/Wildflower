import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'
import { InsufficientScopeSchema } from 'shared-structures-core/http-api-definition'

/**
 * Why a bearer gate refused a logged request with a `401`. Mirrors the Rust
 * `RequestRefusalBody`.
 */
const RequestRefusalSchema = Schema.Literal('missingToken', 'tokenRejected', 'revoked')

/**
 * What the request log holds for one (caller, client address) pair — a row of
 * `GET /requests/callers`, mirroring the Rust `CallerSummaryBody`. The
 * wire's nullable fields (`null` in JSON) decode to an `Option`: `clientId` is
 * `None` for the requests no bearer gate verified, `address` when the trusted
 * front recorded no visitor address, and `lastRefusal` when no bearer gate
 * refused the newest request. Resolve a client's display name through
 * gatekeeper's client list. `refusedCount` counts a bearer gate's `401`s and
 * scope `403`s.
 */
const CallerSummarySchema = Schema.Struct({
  clientId: Schema.OptionFromNullOr(Schema.String),
  address: Schema.OptionFromNullOr(Schema.String),
  firstSeen: Schema.DateTimeUtc,
  lastSeen: Schema.DateTimeUtc,
  requestCount: Schema.Int,
  refusedCount: Schema.Int,
  lastStatus: Schema.Int,
  lastRefusal: Schema.OptionFromNullOr(RequestRefusalSchema),
})

/**
 * One request in the log — an element of `GET /requests`, mirroring the
 * Rust `LoggedRequestBody`. `path` is the route the request was reduced to (no
 * ids, no query string); a higher `id` is newer. The wire's nullable fields
 * (`null` in JSON) decode to an `Option`: `clientId` is `None` when no bearer
 * gate verified a caller, `address` when the trusted front recorded none,
 * `servedHost` when no public host was addressed, `responseBytes` when the body's
 * length wasn't known up front, and `refusal` when no bearer gate refused it.
 */
const LoggedRequestSchema = Schema.Struct({
  id: Schema.Int,
  receivedAt: Schema.DateTimeUtc,
  clientId: Schema.OptionFromNullOr(Schema.String),
  address: Schema.OptionFromNullOr(Schema.String),
  servedHost: Schema.OptionFromNullOr(Schema.String),
  method: Schema.String,
  path: Schema.String,
  status: Schema.Int,
  responseBytes: Schema.OptionFromNullOr(Schema.Int),
  durationMs: Schema.Int,
  refusal: Schema.OptionFromNullOr(RequestRefusalSchema),
})

/**
 * One page of `GET /requests`, newest first — mirrors the Rust
 * `RequestLogPageBody`. `nextCursor` is the `cursor` that reads the next page;
 * it is `null` on the wire on the last page and decodes to an `Option`.
 */
const RequestLogPageSchema = Schema.Struct({
  requests: Schema.Array(LoggedRequestSchema),
  nextCursor: Schema.OptionFromNullOr(Schema.Int),
})

/**
 * How a logged request fared against auth — the `auth` filter of
 * `GET /requests`, mirroring the Rust `RequestAuthParam`: `authorized`
 * needed auth and carried a valid token (a verified caller, not refused),
 * `public` didn't need auth (no verified caller, not refused), and `refused`
 * failed auth (a bearer gate's `401` or a scope `403`).
 */
const RequestAuthSchema = Schema.Literal('authorized', 'public', 'refused')

/**
 * `GET /requests` query — mirrors the Rust `ListRequestsParams`. Every
 * parameter is optional, and every one given must match: `cursor` is the
 * previous page's `nextCursor`, `client` a verified caller's OAuth client,
 * `address` a client address, and `auth` an auth case (see
 * `RequestAuthSchema`).
 *
 * A query string carries every value as text, so `cursor` decodes from a
 * string; its `jsonSchema` annotation documents the value the string holds, as
 * the server's spec does (`integer`).
 */
const ListRequestsUrlParamsSchema = Schema.Struct({
  cursor: Schema.optional(
    Schema.compose(Schema.NumberFromString, Schema.Int).annotations({
      jsonSchema: { type: 'integer' },
    })
  ),
  client: Schema.optional(Schema.String),
  address: Schema.optional(Schema.String),
  auth: Schema.optional(RequestAuthSchema),
})

/**
 * The request log's endpoints. The group carries no middleware — auth is
 * applied by the host: the Rust server serves `/requests` behind the gatekeeper
 * bearer gate, and the TS client layer leaves the credential to the host app's
 * `HttpClient` (see `request-log-react/src/client/request-log-client.ts`).
 *
 * Both endpoints are scope-gated on the Rust side by `wildflower/RequestLog.r`,
 * returning a `403 InsufficientScope` when the token doesn't cover it.
 *
 * `ListCallers` reads the log grouped by (caller, client address), the group
 * with the newest request first; `ListRequests` reads it one page at a time,
 * newest first, keyset-paged on id through `cursor`.
 */
const httpApiGroup = HttpApiGroup.make('requestLog', { topLevel: false })
  .add(
    HttpApiEndpoint.get('ListCallers', '/requests/callers')
      .addSuccess(Schema.Array(CallerSummarySchema))
      .addError(InsufficientScopeSchema, { status: 403 })
  )
  .add(
    HttpApiEndpoint.get('ListRequests', '/requests')
      .setUrlParams(ListRequestsUrlParamsSchema)
      .addSuccess(RequestLogPageSchema)
      .addError(InsufficientScopeSchema, { status: 403 })
  )

export {
  CallerSummarySchema,
  httpApiGroup,
  ListRequestsUrlParamsSchema,
  LoggedRequestSchema,
  RequestAuthSchema,
  RequestLogPageSchema,
  RequestRefusalSchema,
}
