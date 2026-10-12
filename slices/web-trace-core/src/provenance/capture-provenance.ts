import { type DateTime, Effect, type ParseResult } from 'effect'

import type { Meta } from '@wildflowerhealthio/fhir-r4/data-types'
import type { DocumentReference } from '@wildflowerhealthio/fhir-r4/resources'

import {
  type BodyDigestUnavailable,
  type CaptureHeaders,
  storeBodyVerbatim,
} from '../capture/index.ts'
import { toDocumentReference } from '../codec/index.ts'
import { noTimings, type TraceExchange, traceResourceId } from '../trace-exchange.ts'

/**
 * The minimum a resource must expose to be linked: FHIR's `resourceType` and
 * `id`, plus the `meta` slot the back-link is written into.
 *
 * @remarks
 * Structural rather than the `FhirResource` union, so a caller whose parse
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
  readonly trace: DocumentReference.Type
  /** The produced resources, each carrying `meta.source` back to the trace. */
  readonly linked: readonly TResource[]
}

/**
 * The readable surface of a captured response — the fields a capture consumes.
 *
 * @remarks
 * Structural on purpose: this names the fields rather than a class, so any
 * response object exposing them satisfies it as-is and is passed straight
 * through instead of copying fields into an intermediate.
 *
 * `bytes()` is the body read, **never `text()`**: `text()` is UTF-8 and lossy,
 * and the stored body has to be byte-identical to what arrived for a hash over
 * it to mean anything.
 */
interface CapturedResponse {
  /** The sniffer's per-request correlation key. */
  readonly id: string
  readonly url: string
  readonly status: number
  readonly statusText: string
  readonly headers: CaptureHeaders
  /** The response-start instant the sniffer observed. */
  readonly startedAt: DateTime.Utc
  /** The raw body, as the bytes that arrived. */
  bytes(): Uint8Array<ArrayBuffer>
}

/**
 * The response facts every trace states, projected once.
 *
 * @param sessionId - The id every trace from one run shares
 * @param response - The response, as observed
 * @returns The sniffer-observed half of a `TraceExchange`
 *
 * @remarks
 * This is the **single** statement of the response → exchange field mapping.
 * A builder of a trace — the provenance capture below — spreads this rather
 * than restating the seven fields, so the mapping cannot drift between
 * builders. What varies per builder (`timings`, `body`, `producedResources`)
 * stays at the call site.
 */
const toExchangeFields = (
  sessionId: string,
  response: CapturedResponse
): Pick<
  TraceExchange,
  'sessionId' | 'requestId' | 'url' | 'status' | 'statusText' | 'headers' | 'startedAt'
> => ({
  sessionId,
  requestId: response.id,
  url: response.url,
  status: response.status,
  statusText: response.statusText,
  headers: response.headers,
  startedAt: response.startedAt,
})

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

/**
 * Capture one response as the provenance of the resources it produced.
 *
 * @param sessionId - The id every trace from this run shares
 * @param response - The response, as observed
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
  sessionId: string,
  response: CapturedResponse,
  produced: readonly TResource[]
): Effect.Effect<ProvenanceCapture<TResource>, BodyDigestUnavailable | ParseResult.ParseError> =>
  Effect.gen(function* () {
    const body = yield* storeBodyVerbatim(response.bytes(), response.headers)
    const references = produced.flatMap((resource) => {
      const reference = referenceTo(resource)
      return reference === null ? [] : [reference]
    })
    const trace = yield* toDocumentReference({
      ...toExchangeFields(sessionId, response),
      timings: noTimings,
      body,
      producedResources: references,
    })
    const source = `DocumentReference/${traceResourceId({
      sessionId,
      requestId: response.id,
    })}`
    return {
      trace,
      linked: produced.map((resource) => withMetaSource(resource, source)),
    }
  })

/** What a provenance hook returns for one response. */
interface ProvenanceHookResult<TResource> {
  /** The parse output, each resource carrying `meta.source` back to the trace. */
  readonly resources: readonly TResource[]
  /** The trace — persisted best-effort, never part of the run's summary. */
  readonly diagnostics: readonly DocumentReference.Type[]
}

/**
 * Build a provenance hook for one source.
 *
 * @param sessionPrefix - Names the source in every session id the hook writes
 *   (`fhir-r4`, `rexall`, …)
 * @returns A hook taking a run id, a response, and the resources parsed from
 *   it, which captures the response's provenance
 *
 * @remarks
 * The caller mints the run id and invokes the hook only for a parse that
 * actually produced resources; the hook returns the linked resources, and the
 * trace as a `diagnostics` entry meant as a best-effort write.
 *
 * The prefix keeps a session legible in the viewer without opening an exchange;
 * the run id is what makes two runs distinct — a trace's resource id is derived
 * from `(sessionId, requestId)`, so a stable session id would silently upsert
 * the second run's traces over the first's.
 *
 * The signature is spelled out structurally here, so this package names no
 * caller's hook type.
 */
const makeFhirProvenanceCapture =
  (sessionPrefix: string) =>
  <TResource extends ReferencableResource>(
    runId: string,
    response: CapturedResponse,
    produced: readonly TResource[]
  ): Effect.Effect<
    ProvenanceHookResult<TResource>,
    BodyDigestUnavailable | ParseResult.ParseError
  > =>
    Effect.map(
      captureProvenance(`${sessionPrefix}-${runId}`, response, produced),
      ({ trace, linked }) => ({ resources: linked, diagnostics: [trace] })
    )

export {
  type CapturedResponse,
  captureProvenance,
  makeFhirProvenanceCapture,
  type ProvenanceCapture,
  type ProvenanceHookResult,
  type ReferencableResource,
  referenceTo,
  toExchangeFields,
  withMetaSource,
}
