import { Array as Arr, Effect, Option, Schema } from 'effect'

import type * as Bundle from '../data-types/resources/bundle.ts'
import { FhirResourceSchema, type FhirResource } from '../resources/index.ts'
import * as Telemetry from '../telemetry/index.ts'
import { FhirR4ResourcesHttpApiClient } from './fhir-r4-resources-http-api-client.ts'
import { diffJson, setAtPath, type FieldDiff } from './field-diff.ts'
import { statusOk } from './persist-batch-bundle.ts'

/**
 * Pre-fetching the FHIR store to say, per resource in a would-be write, whether
 * the id is `new` (absent), `unchanged` (present + wire-equal after dropping
 * server-managed fields), or `changed` (present + differs) — so a preview can
 * badge each row and a caller (the importer's confirmed batch) can opt-out
 * `unchanged` resources by default rather than blind-overwriting them. A
 * `changed` result also carries the leaf-level {@link FieldDiff}s (server value
 * → incoming value) so the badge can show *what* differs, and the server's
 * normalized copy so a reviewer can reset any leaf back to it
 * ({@link resetFieldToServer}).
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
 * A resource's full comparison against the server: its {@link DiffStatus}, and
 * — whenever the server holds a decodable copy — the leaf-level
 * {@link FieldDiff}s (empty for `unchanged`) plus that server copy.
 *
 * @remarks
 * `fields` is the classify-time snapshot of what differed (server → incoming),
 * for a badge to show `name[0].family "Smith" -> "Smyth"`. `server` is the
 * server's normalized wire object, present whenever the server holds a
 * decodable copy — both `unchanged` and `changed`, absent only for `new` (no
 * copy) or an opaque `changed` (a copy that would not decode). Carrying it on
 * `unchanged` too is deliberate: a caller can *recompute* the diff against the
 * resource as it edits it (`diffJson(server, normalizedEncode(edited))`), so an
 * edit to an `unchanged` resource surfaces as a diff, and a per-leaf reset
 * drops a line the moment it matches again.
 */
interface ServerComparison {
  readonly status: DiffStatus
  readonly fields: readonly FieldDiff[]
  readonly server?: unknown
}

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
 * Encode a resource through its schema and drop the server-managed meta
 * fields — the wire object the content compare and the field diff both work
 * over. `Option.none` on an encode failure: a resource that cannot be encoded
 * is treated as `changed` (safer than `unchanged`, which would silently skip
 * it).
 */
const normalizedEncode = (resource: unknown): Option.Option<unknown> => {
  const encoded = encodeResource(resource)
  if (encoded._tag !== 'Right') return Option.none()
  return Option.some(normalize(encoded.right))
}

/**
 * Reset one leaf of a resource back to the server's value: encode the
 * resource, {@link setAtPath | set} the leaf `field` names to `field.server`
 * (removing it when the server has none there), and decode the result back to
 * a typed resource.
 *
 * @param resource - The current (possibly already-edited) incoming resource
 * @param field - The leaf to reset, from a {@link ServerComparison}'s `fields`
 * @returns `Some` the resource with that one leaf matching the server, or
 *   `None` when the resource cannot round-trip through the schema
 */
const resetFieldToServer = (resource: unknown, field: FieldDiff): Option.Option<FhirResource> => {
  const encoded = encodeResource(resource)
  if (encoded._tag !== 'Right') return Option.none()
  const patched = setAtPath(encoded.right, field.path, field.server)
  const decoded = decodeResource(patched)
  return decoded._tag === 'Right' ? Option.some(decoded.right) : Option.none()
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
 * @returns A map from `Type/id` to {@link ServerComparison}; empty when
 *   nothing readable was submitted. Never fails — if the whole `POST /` fails,
 *   every probed id is reported as `new` (the caller's writes will still
 *   attempt).
 */
const classifyAgainstServer = (
  resources: ReadonlyArray<FhirResource>
): Effect.Effect<ReadonlyMap<string, ServerComparison>, never, FhirR4ResourcesHttpApiClient> =>
  Effect.gen(function* () {
    const readable = resources.filter((resource) => resource.id !== null)
    if (readable.length === 0) return new Map<string, ServerComparison>()

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

    const classifications = new Map<string, ServerComparison>()
    const asNew: ServerComparison = { status: 'new', fields: [] }
    // A `changed` we could not open up to leaf detail — no field list, no
    // server copy to reset against. Distinct object per use is unnecessary; it
    // carries no mutable state.
    const opaqueChange: ServerComparison = { status: 'changed', fields: [] }

    if (submission._tag === 'failed') {
      for (const resource of readable) classifications.set(diffKey(resource), asNew)
      return classifications
    }

    for (const [resource, entry] of Arr.zip(readable, submission.response.entry ?? [])) {
      const key = diffKey(resource)
      const status = entry.response?.status
      if (status === undefined) {
        classifications.set(key, asNew)
        continue
      }
      if (!statusOk(status)) {
        // `404 Not Found` and any other non-2xx (`410 Gone` included) — the
        // server does not present a stored copy at this id, so a caller's
        // write will create fresh.
        classifications.set(key, asNew)
        continue
      }
      const serverCopy: unknown = entry.resource
      if (serverCopy === null || serverCopy === undefined) {
        // 2xx with no entry.resource is a shape a spec-compliant server won't
        // send for a GET, but a real server can (an OperationOutcome, a
        // stripped body). Treat it as `changed` so we don't silently
        // overwrite an equivalent server copy we couldn't verify.
        classifications.set(key, opaqueChange)
        continue
      }
      const decoded = asFhirResource(serverCopy)
      if (decoded._tag !== 'Some') {
        classifications.set(key, opaqueChange)
        continue
      }
      const incoming = normalizedEncode(resource)
      const existing = normalizedEncode(decoded.value)
      if (incoming._tag !== 'Some' || existing._tag !== 'Some') {
        classifications.set(key, opaqueChange)
        continue
      }
      if (JSON.stringify(incoming.value) === JSON.stringify(existing.value)) {
        // Carry the server copy even though nothing differs now, so an edit
        // to this resource can be diffed against it (see ServerComparison).
        classifications.set(key, { status: 'unchanged', fields: [], server: existing.value })
        continue
      }
      classifications.set(key, {
        status: 'changed',
        fields: diffJson(existing.value, incoming.value),
        server: existing.value,
      })
    }

    // Any resources missing a matched response entry (a truncated response)
    // default to `new` — a caller's write will attempt and either land or
    // report itself as a persist failure.
    for (const resource of readable) {
      const key = diffKey(resource)
      if (!classifications.has(key)) classifications.set(key, asNew)
    }

    return classifications
  }).pipe(
    Effect.withSpan(Telemetry.Persist.Classify.Span.Name, {
      attributes: {
        [Telemetry.Persist.Attributes.ResourceCount]: resources.length,
      },
    })
  )

export {
  classifyAgainstServer,
  diffKey,
  normalizedEncode,
  resetFieldToServer,
  SERVER_MANAGED_META_FIELDS,
  type DiffStatus,
  type ServerComparison,
}
