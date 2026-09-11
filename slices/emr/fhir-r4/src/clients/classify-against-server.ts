import { Array as Arr, Effect, Option, Schema } from 'effect'

import type * as Bundle from '../data-types/resources/bundle.ts'
import { FhirResourceSchema, type FhirResource } from '../resources/index.ts'
import * as Telemetry from '../telemetry/index.ts'
import { FhirR4ResourcesHttpApiClient } from './fhir-r4-resources-http-api-client.ts'
import { statusOk } from './persist-batch-bundle.ts'

/**
 * Pre-fetching the FHIR store to say, per resource in a would-be write, whether
 * the id is `new` (absent), `unchanged` (present + wire-equal after dropping
 * server-managed fields), or `changed` (present + differs) — so a preview can
 * badge each row and a caller (the importer's confirmed batch) can opt-out
 * `unchanged` resources by default rather than blind-overwriting them.
 *
 * @packageDocumentation
 */

/**
 * One resource's status relative to the server.
 *
 * @remarks
 * `new` — the server does not hold this id (`404`), so writing creates a
 *   fresh resource. `unchanged` — the server holds this id and its stored
 *   wire shape matches the would-be write, minus fields the server manages
 *   ({@link SERVER_MANAGED_META_FIELDS}). `changed` — the server holds this
 *   id but its stored wire shape differs. A caller (the importer's preview)
 *   defaults `unchanged` rows to excluded so a re-import does not silently
 *   overwrite an equivalent stored resource.
 */
type DiffStatus = 'new' | 'unchanged' | 'changed'

/**
 * `meta` fields the server sets on write and echoes back on read — comparing
 * against the client's would-be write would report every `unchanged` resource
 * as `changed` because these values only exist on the server side.
 *
 * @remarks
 * `versionId` and `lastUpdated` are server-owned (§ 3.4.4.1); `source` is
 * client-stamped but by a *later* step (`withMetaSource` in the importer
 * shell) than the resources handed here, so it appears on the server copy but
 * not on the wire form of the incoming resource. Dropping all three from both
 * sides is what lets the compare reflect a real content diff. `profile`,
 * `security`, `tag` are client-owned and *do* count as content — a re-import
 * that changes tags is a real diff.
 */
const SERVER_MANAGED_META_FIELDS = ['versionId', 'lastUpdated', 'source'] as const

/**
 * Stable per-resource key for the returned diff map — `resourceType/id`, the
 * same shape the batch bundle addresses entries by, so a caller can look a
 * status up by the same key it already holds. A null-id resource is skipped
 * (a caller cannot address it) and returns no entry.
 */
const diffKey = (resource: FhirResource): string => `${resource.resourceType}/${resource.id ?? ''}`

/**
 * The wire projection compared for equality — the resource encoded through its
 * schema (so `URL` fields round-trip as strings, per the Consumer Gotchas), with
 * `meta` narrowed to non-server-managed fields.
 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object'

const isServerManaged = (key: string): boolean =>
  (SERVER_MANAGED_META_FIELDS as readonly string[]).includes(key)

const normalize = (encoded: unknown): unknown => {
  if (!isRecord(encoded)) return encoded
  const meta = encoded['meta']
  if (!isRecord(meta)) return encoded
  const filtered: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(meta)) {
    if (!isServerManaged(key)) filtered[key] = value
  }
  return { ...encoded, meta: filtered }
}

const encodeResource = Schema.encodeUnknownEither(FhirResourceSchema)
const decodeResource = Schema.decodeUnknownEither(FhirResourceSchema)

/**
 * Encode + normalize once, JSON-stringify for a stable content compare.
 * Falls back to `Option.none` on an encode failure — a resource that cannot
 * be encoded is treated as `changed` (safer than `unchanged`, which would
 * silently skip it).
 */
const canonicalize = (resource: FhirResource): Option.Option<string> => {
  const encoded = encodeResource(resource)
  if (encoded._tag !== 'Right') return Option.none()
  return Option.some(JSON.stringify(normalize(encoded.right)))
}

/**
 * The endpoint types entry.resource as `Schema.Any` (see the endpoint's
 * remarks for why). Decoding through `FhirResourceSchema` here is what turns
 * that back into a typed `FhirResource` so the wire compare has something
 * meaningful to look at.
 */
const asFhirResource = (serverCopy: unknown): Option.Option<FhirResource> => {
  const decoded = decodeResource(serverCopy)
  return decoded._tag === 'Right' ? Option.some(decoded.right) : Option.none()
}

/**
 * Classify each resource against the server's current copy: `new` (absent),
 * `unchanged` (present + wire-equal after dropping server-managed meta), or
 * `changed` (present + differs).
 *
 * @param resources - The resources a caller (the importer's preview) is about
 *   to write; null-id resources are skipped and get no entry
 * @returns A map from `Type/id` to {@link DiffStatus}; empty when nothing
 *   readable was submitted. Never fails — if the whole `POST /` fails, every
 *   probed id is reported as `new` (the caller's writes will still attempt).
 */
const classifyAgainstServer = (
  resources: ReadonlyArray<FhirResource>
): Effect.Effect<ReadonlyMap<string, DiffStatus>, never, FhirR4ResourcesHttpApiClient> =>
  Effect.gen(function* () {
    const readable = resources.filter((resource) => resource.id !== null)
    if (readable.length === 0) return new Map<string, DiffStatus>()

    const client = yield* FhirR4ResourcesHttpApiClient

    const payload: Bundle.BundleValue<unknown> = {
      resourceType: 'Bundle' as const,
      type: 'batch' as const,
      id: null,
      implicitRules: null,
      language: null,
      meta: null,
      identifier: null,
      link: [],
      signature: null,
      timestamp: null,
      total: null,
      entry: readable.map((resource) => ({
        id: null,
        extension: [],
        modifierExtension: [],
        fullUrl: null,
        link: [],
        request: {
          id: null,
          extension: [],
          modifierExtension: [],
          method: 'GET' as const,
          url: diffKey(resource),
          ifNoneMatch: null,
          ifModifiedSince: null,
          ifMatch: null,
          ifNoneExist: null,
        },
        resource: null,
        response: null,
        search: null,
      })),
    }

    const submission = yield* client.Bundle.Submit({ payload }).pipe(
      Effect.matchEffect({
        onSuccess: (response) => Effect.succeed({ _tag: 'ok' as const, response }),
        onFailure: (_cause: unknown) => Effect.succeed({ _tag: 'failed' as const }),
      })
    )

    const classifications = new Map<string, DiffStatus>()

    if (submission._tag === 'failed') {
      for (const resource of readable) classifications.set(diffKey(resource), 'new')
      return classifications
    }

    for (const [resource, entry] of Arr.zip(readable, submission.response.entry ?? [])) {
      const key = diffKey(resource)
      const status = entry.response?.status
      if (status === undefined) {
        classifications.set(key, 'new')
        continue
      }
      if (!statusOk(status)) {
        // `404 Not Found` and any other non-2xx (`410 Gone` included) — the
        // server does not present a stored copy at this id, so a caller's
        // write will create fresh.
        classifications.set(key, 'new')
        continue
      }
      const serverCopy: unknown = entry.resource
      if (serverCopy === null || serverCopy === undefined) {
        // 2xx with no entry.resource is a shape a spec-compliant server won't
        // send for a GET, but a real server can (an OperationOutcome, a
        // stripped body). Treat it as `changed` so we don't silently
        // overwrite an equivalent server copy we couldn't verify.
        classifications.set(key, 'changed')
        continue
      }
      const decoded = asFhirResource(serverCopy)
      if (decoded._tag !== 'Some') {
        classifications.set(key, 'changed')
        continue
      }
      const incoming = canonicalize(resource)
      const existing = canonicalize(decoded.value)
      if (incoming._tag !== 'Some' || existing._tag !== 'Some') {
        classifications.set(key, 'changed')
        continue
      }
      classifications.set(key, incoming.value === existing.value ? 'unchanged' : 'changed')
    }

    // Any resources missing a matched response entry (a truncated response)
    // default to `new` — a caller's write will attempt and either land or
    // report itself as a persist failure.
    for (const resource of readable) {
      const key = diffKey(resource)
      if (!classifications.has(key)) classifications.set(key, 'new')
    }

    return classifications
  }).pipe(
    Effect.withSpan(Telemetry.Persist.Classify.Span.Name, {
      attributes: {
        [Telemetry.Persist.Attributes.ResourceCount]: resources.length,
      },
    })
  )

export { classifyAgainstServer, diffKey, SERVER_MANAGED_META_FIELDS, type DiffStatus }
