import { type DateTime, Effect, type ParseResult } from 'effect'

import type { Meta } from 'fhir-r4/data-types'

import {
  type BodyDigestUnavailable,
  type CaptureHeaders,
  storeBodyVerbatim,
} from '../capture/index.ts'
import { type DocumentReferenceType, toDocumentReference } from '../codec/index.ts'
import { noTimings, traceResourceId } from '../trace-exchange.ts'

/**
 * The minimum a resource must expose to be linked: FHIR's `resourceType` and
 * `id`, plus the `meta` slot the back-link is written into.
 *
 * @remarks
 * Structural rather than the `FhirResource` union, so a collector whose entity
 * produces a narrower type (a `MedicationRequest | MedicationDispense`, say)
 * keeps that type through the link instead of being widened.
 */
interface ReferencableResource {
  readonly resourceType: string
  readonly id: string | null
  readonly meta: typeof Meta.Schema.Type | null
}

/** What one response's capture produced. */
interface ProvenanceCapture<TResource> {
  /** The trace, naming every resource below in `context.related`. */
  readonly trace: DocumentReferenceType
  /** The produced resources, each carrying `meta.source` back to the trace. */
  readonly linked: readonly TResource[]
}

/**
 * The relative FHIR reference for a resource, or `null` when it has no id.
 *
 * @param resource - The produced resource
 * @returns `Type/id`, or `null` for an id-less resource
 *
 * @remarks
 * An id-less resource is not skipped out of caution — `upsertResource` cannot
 * write one either, so a reference to it would point at nothing. A link that
 * does not resolve is worse than an absent one: it reads as evidence.
 */
const referenceTo = (resource: ReferencableResource): string | null =>
  resource.id === null ? null : `${resource.resourceType}/${resource.id}`

/**
 * Set `meta.source` on a resource, preserving whatever else its `meta` carried.
 *
 * @param resource - The resource to link
 * @param source - The relative reference of the trace that produced it
 * @returns The resource with `meta.source` set
 *
 * @remarks
 * **This link is single-valued and the last writer wins.** FHIR's `meta.source`
 * is one `uri`, so a resource derived from a list response *and* a detail
 * response can only name one of them here. That is why the authoritative
 * direction is the trace's `context.related`, which names every resource an
 * exchange produced and therefore survives multiple sources by construction.
 * Treat `meta.source` as the convenient pointer, not the record.
 */
const withMetaSource = <TResource extends ReferencableResource>(
  resource: TResource,
  source: string
): TResource => ({
  ...resource,
  meta: {
    lastUpdated: null,
    profile: [],
    security: [],
    tag: [],
    versionId: null,
    ...resource.meta,
    source,
  },
})

/** The response facts a capture needs. A collector reads these off its `RemoteResponse`. */
interface CaptureInput {
  /** Identifies the collector run; shared by every trace it writes. */
  readonly sessionId: string
  /** The sniffer's per-request correlation key. */
  readonly requestId: string
  readonly url: string
  readonly status: number
  readonly statusText: string
  readonly headers: CaptureHeaders
  /** The response-start instant the sniffer observed. */
  readonly startedAt: DateTime.Utc
  /** The raw body, read through `RemoteResponse.bytes()` — never `text()`. */
  readonly bytes: Uint8Array<ArrayBuffer>
}

/**
 * Capture one response as the provenance of the resources it produced.
 *
 * @param input - The response, as observed
 * @param produced - The resources this response's entity derived from it
 * @returns The trace and the same resources, linked both ways
 *
 * @remarks
 * Both directions are written because either alone is a real usability loss:
 * `context.related` answers "what did this response produce" and is the only
 * direction that survives a resource having several sources; `meta.source`
 * answers "where did this resource come from" with a direct read rather than a
 * search — which matters, because the typed client expresses no reference-typed
 * search parameter, so there is no query for "every trace naming this resource".
 *
 * `timings` is `noTimings`: unlike a recorder, this runs after an entity has
 * already decoded the body, so the interval from response start to here is
 * mostly that decode. Reporting it as `receive` would make the trace claim a
 * transfer time it did not measure.
 *
 * The caller is expected to have checked that `produced` is non-empty — a
 * response that produced nothing is not captured at all, which is what separates
 * this from bulk recording. A capture of an empty `produced` is still
 * well-formed (a trace with no `context.related`); it just is not what this is
 * for.
 */
const captureProvenance = <TResource extends ReferencableResource>(
  input: CaptureInput,
  produced: readonly TResource[]
): Effect.Effect<ProvenanceCapture<TResource>, BodyDigestUnavailable | ParseResult.ParseError> =>
  Effect.gen(function* () {
    const body = yield* storeBodyVerbatim(input.bytes, input.headers)
    const references = produced.flatMap((resource) => {
      const reference = referenceTo(resource)
      return reference === null ? [] : [reference]
    })
    const trace = yield* toDocumentReference({
      sessionId: input.sessionId,
      requestId: input.requestId,
      url: input.url,
      status: input.status,
      statusText: input.statusText,
      headers: input.headers,
      startedAt: input.startedAt,
      timings: noTimings,
      body,
      producedResources: references,
    })
    const source = `DocumentReference/${traceResourceId({
      sessionId: input.sessionId,
      requestId: input.requestId,
    })}`
    return {
      trace,
      linked: produced.map((resource) => withMetaSource(resource, source)),
    }
  })

export {
  captureProvenance,
  type CaptureInput,
  type ProvenanceCapture,
  type ReferencableResource,
  referenceTo,
  withMetaSource,
}
