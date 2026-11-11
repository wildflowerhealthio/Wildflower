import { HttpClient, HttpClientRequest, type HttpClientResponse } from '@effect/platform'
import { Data, Effect, Option, Schema } from 'effect'

import { IdSchema } from '../data-types/base/primitives.ts'
import * as ResourceType from '../resources/resource-type.ts'
import { operationOutcomeTextOf } from './operation-outcome-text.ts'

/**
 * Writing one resource of any R4 type to a FHIR server, as JSON: a create
 * (`POST <type>`) or a version-checked update (`PUT <type>/<id>` with
 * `If-Match`), each answered with the record as the server stored it.
 *
 * @remarks
 * A namespace module: `ResourceWrite.ResourceJson`, `ResourceWrite.Written`,
 * `ResourceWrite.Failure`, `ResourceWrite.Failed`, `ResourceWrite.create`,
 * `ResourceWrite.update`, `ResourceWrite.weakETagOf`.
 *
 * Type-agnostic where `upsertResource` and the typed `FhirR4ResourcesHttpApiClient`
 * are per type: the resource is sent as the JSON it is, so a caller can
 * write any type a grant covers without a schema for it. Requests go out over
 * the `HttpClient` in the context with base-relative URLs (`Observation`,
 * `Observation/123`); the client names the base, as `fhir-r4-react`'s
 * `SmartClient` does. Every write asks for the stored record back
 * (`Prefer: return=representation`), so its `id` and `meta.versionId` are
 * read from the answer.
 *
 * @packageDocumentation
 */

/** A resource as JSON, as a write sends it: its R4 type, and its other fields as given. */
interface ResourceJson {
  readonly resourceType: ResourceType.Type
  readonly [field: string]: unknown
}

/**
 * The part of a written record a write reads back: its known type, its id
 * and its `meta.versionId`. Nothing else is decoded, so a stored record this
 * package's stricter schemas would refuse still reads as written.
 */
const WrittenRecordSchema = Schema.Struct({
  resourceType: ResourceType.Schema,
  id: IdSchema,
  meta: Schema.optional(Schema.Struct({ versionId: Schema.optional(Schema.String) })),
})

/** The record a write stored, as the server answered with it. */
interface Written {
  /** The stored record as the server sent it back, as JSON. */
  readonly record: unknown
  /** The id the record is stored under: the server's for a create. */
  readonly id: string
  /** The stored version (`meta.versionId`); `None` when the server keeps no versions. */
  readonly versionId: Option.Option<string>
}

/** Why a write failed. */
type Failure =
  /**
   * The server answered 412 Precondition Failed: the record's stored version
   * is no longer the one `If-Match` named, since something changed it.
   */
  | { readonly kind: 'precondition-failed' }
  /** The server answered with another error status, and what its `OperationOutcome` said, if it sent one. */
  | {
      readonly kind: 'error-status'
      readonly status: number
      readonly outcomeText: Option.Option<string>
    }
  /** No answer arrived: the request was blocked, the connection dropped, or the server is down. */
  | { readonly kind: 'unreachable' }
  /**
   * The server answered with the success status `status`, so it likely
   * stored the record, but its answer was not a record with an id this could
   * read.
   */
  | { readonly kind: 'accepted-unreadable'; readonly status: number }

/** A write that failed, and why. */
class Failed extends Data.TaggedError('ResourceWriteFailed')<{ readonly failure: Failure }> {}

/** `versionId` as the weak entity tag `If-Match` names it by: `W/"<versionId>"` (FHIR R4 §3.1.0.5.1). */
const weakETagOf = (versionId: string): string => `W/"${versionId}"`

const fail = (failure: Failure): Effect.Effect<never, Failed> =>
  Effect.fail(new Failed({ failure }))

const decodeWrittenRecord = Schema.decodeUnknownOption(WrittenRecordSchema)

/** Whether `response` has a success (2xx) status. */
const isSuccess = ({ status }: HttpClientResponse.HttpClientResponse): boolean =>
  status >= 200 && status < 300

/** The record a 2xx `response` holds, or the failure saying it couldn't be read. */
const writtenFrom = (
  response: HttpClientResponse.HttpClientResponse
): Effect.Effect<Written, Failed> =>
  response.json.pipe(
    Effect.option,
    Effect.flatMap((body) =>
      Option.flatMap(body, (record) =>
        decodeWrittenRecord(record).pipe(
          Option.map(({ id, meta }): Written => ({
            record,
            id,
            versionId: Option.fromNullable(meta?.versionId),
          }))
        )
      ).pipe(
        Option.match({
          onNone: () => fail({ kind: 'accepted-unreadable', status: response.status }),
          onSome: Effect.succeed,
        })
      )
    )
  )

/** The failure an error-status `response` stands for, its `OperationOutcome` read from its body. */
const failureFrom = (
  response: HttpClientResponse.HttpClientResponse
): Effect.Effect<never, Failed> =>
  response.status === 412
    ? fail({ kind: 'precondition-failed' })
    : response.json.pipe(
        Effect.option,
        Effect.flatMap((body) =>
          fail({
            kind: 'error-status',
            status: response.status,
            outcomeText: Option.flatMap(body, operationOutcomeTextOf),
          })
        )
      )

/** Send `request` with `resource` as its body, and read the answer. */
const send = (
  request: HttpClientRequest.HttpClientRequest,
  resource: ResourceJson
): Effect.Effect<Written, Failed, HttpClient.HttpClient> =>
  Effect.flatMap(HttpClient.HttpClient, (client) =>
    client.execute(
      request.pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.setHeader('prefer', 'return=representation'),
        HttpClientRequest.bodyText(JSON.stringify(resource), 'application/fhir+json')
      )
    )
  ).pipe(
    Effect.flatMap((response) =>
      isSuccess(response) ? writtenFrom(response) : failureFrom(response)
    ),
    Effect.catchTags({
      // No response arrived: refused before it left, or the connection dropped.
      RequestError: () => fail({ kind: 'unreachable' }),
      // A response arrived whose body could not be read.
      ResponseError: ({ response }) =>
        isSuccess(response)
          ? fail({ kind: 'accepted-unreadable', status: response.status })
          : failureFrom(response),
    })
  )

/**
 * Create `resource`: `POST <resourceType>`, the server choosing the id (any
 * `id` the resource carries is the server's to ignore).
 */
const create = ({
  resource,
}: {
  readonly resource: ResourceJson
}): Effect.Effect<Written, Failed, HttpClient.HttpClient> =>
  send(HttpClientRequest.post(resource.resourceType), resource)

/**
 * Update the record `resource` is (its type and id) to `resource`, only if
 * its stored version is still `versionId`: `PUT <resourceType>/<id>` with
 * `If-Match: W/"<versionId>"`, the id percent-encoded so it stays one path
 * segment. A record changed since that version fails as
 * `precondition-failed`.
 */
const update = ({
  resource,
  versionId,
}: {
  readonly resource: ResourceJson & { readonly id: string }
  /** The version the update was made against, as the record's `meta.versionId` said when it was read. */
  readonly versionId: string
}): Effect.Effect<Written, Failed, HttpClient.HttpClient> =>
  send(
    HttpClientRequest.put(`${resource.resourceType}/${encodeURIComponent(resource.id)}`).pipe(
      HttpClientRequest.setHeader('if-match', weakETagOf(versionId))
    ),
    resource
  )

export { create, Failed, update, weakETagOf }
export type { Failure, ResourceJson, Written }
