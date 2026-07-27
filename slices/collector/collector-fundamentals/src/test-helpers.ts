import { DateTime, Effect, Schema } from 'effect'

import * as EntityDefinition from './model/entity-definition.ts'
import { RemoteResponse, type RemoteResponseHeaders } from './model/response.ts'

/**
 * Fields a test wants to vary on a {@link RemoteResponse}; everything omitted
 * takes a benign default.
 */
interface RemoteResponseOverrides {
  readonly id?: string
  readonly url?: string
  readonly status?: number
  readonly statusText?: string
  readonly headers?: RemoteResponseHeaders
  /** The observed response-start instant. Fixed by default, so tests stay deterministic. */
  readonly startedAt?: DateTime.Utc
  /** Body bytes. A `string` is UTF-8 encoded; pass a `Uint8Array` for a non-UTF-8 body. */
  readonly body?: string | Uint8Array
}

const utf8 = new TextEncoder()

/** The default {@link makeRemoteResponse} `startedAt` — fixed, so tests are deterministic. */
const DEFAULT_STARTED_AT = DateTime.unsafeMake('2026-01-01T00:00:00.000Z')

/**
 * Build a settled {@link RemoteResponse} for a test, defaulting every field a
 * test does not care about.
 *
 * @param overrides - The fields to set; see {@link RemoteResponseOverrides}
 * @returns A `RemoteResponse` with `body` already appended as a single chunk
 *
 * @remarks
 * Six positional constructor arguments is a lot to restate at every call site,
 * and most tests care about one or two of them. Chunk *boundaries* are the one
 * thing this hides — a test about multi-chunk accumulation should call
 * `appendChunk` itself.
 */
const makeRemoteResponse = (overrides: RemoteResponseOverrides = {}): RemoteResponse => {
  const response = new RemoteResponse(
    overrides.id ?? 'req-1',
    overrides.url ?? 'https://example.com/resource/id',
    overrides.status ?? 200,
    overrides.statusText ?? 'OK',
    overrides.headers ?? [['content-type', 'application/json']],
    overrides.startedAt ?? DEFAULT_STARTED_AT
  )
  const body = overrides.body
  if (body !== undefined) {
    response.appendChunk(typeof body === 'string' ? utf8.encode(body) : body)
  }
  return response
}

/**
 * Two reusable test entities for `entity-definition.test.ts` and
 * `collector-bridge-message-handler.test.ts`. Mirror the shape a real
 * entity (e.g. `PatientEntity`) takes — a value built via
 * `EntityDefinition.make`, no inheritance.
 */

const SimpleSchema = Schema.Struct({
  name: Schema.String,
  age: Schema.Number,
})

const SimpleEntity: EntityDefinition.EntityDefinition<typeof SimpleSchema.Type> =
  EntityDefinition.make({
    name: 'SimpleEntity',
    isFoundAt: (url) => /\/people\/\d+$/.test(url),
    parse: (response) =>
      Effect.map(Schema.decode(Schema.parseJson(SimpleSchema))(response.text()), (data) => [data]),
  })

const AnotherSchema = Schema.Struct({ id: Schema.String })

const AnotherEntity: EntityDefinition.EntityDefinition<typeof AnotherSchema.Type> =
  EntityDefinition.make({
    name: 'AnotherEntity',
    isFoundAt: (url) => /\/items\//.test(url),
    parse: (response) =>
      Effect.map(Schema.decode(Schema.parseJson(AnotherSchema))(response.text()), (data) => [data]),
  })

export { AnotherEntity, DEFAULT_STARTED_AT, makeRemoteResponse, SimpleEntity }
export type { RemoteResponseOverrides }
