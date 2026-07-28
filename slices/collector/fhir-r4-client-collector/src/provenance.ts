import { CapturedSource, type EntityDefinition } from 'collector-fundamentals/model'
import { Effect } from 'effect'
import type { FhirResource } from 'fhir-r4/resources'
import { isWebTrace } from 'web-trace-core/codec'
import { captureProvenance } from 'web-trace-core/provenance'

/**
 * Provenance wiring for this collector: every response one of its entities
 * actually derived a resource from is stored verbatim as a trace
 * `DocumentReference`, linked both ways to the resources it produced.
 *
 * @remarks
 * **This file is a near-identical copy of
 * `rexall-be-well-collector/src/provenance.ts`, and that duplication is
 * deliberate.** Slice layering forbids one `*-client-collector` importing
 * another (see [slices/AGENTS.md](../../../AGENTS.md)), which is the same reason
 * `extract-json.ts` is duplicated between the two. The *substance* — the capture
 * policy, the encoding, and both link directions — lives once in
 * `web-trace-core`; what is copied here is only the wiring that reads a
 * `RemoteResponse` and names this collector in the run id. Anything that starts
 * to look like policy belongs upstream in `web-trace-core`, not in a third copy.
 *
 * @packageDocumentation
 */

/**
 * Mint the id every trace from one sync run shares.
 *
 * @returns A fresh run id, prefixed with the collector that produced it
 *
 * @remarks
 * The prefix says *which* collector wrote the trace, so a session in the viewer
 * is legible without opening an exchange; the uuid is what makes two runs of the
 * same configured remote distinct, since `{sessionId}-{requestId}` is the trace's
 * resource id and a stable session id would silently upsert the second run's
 * traces over the first's. Modelled on `web-trace-collector`'s `mintSessionId`,
 * and impure for the same reason.
 */
const mintRunId = (): string => `fhir-r4-${globalThis.crypto.randomUUID()}`

/**
 * Wrap an entity so a non-empty parse also stores the response that produced it.
 *
 * @param sessionId - The run id every trace from this run shares, from
 *   {@link mintRunId}
 * @returns A combinator over an entity, leaving its `name` / `isFoundAt` /
 *   `followUpSteps` behaviour untouched
 *
 * @remarks
 * The batch handed back is `[...linked, trace]`: the entity's own resources,
 * each carrying `meta.source` back to the trace, followed by the trace naming
 * all of them in `context.related`. `withCapturedSource` guarantees the parts
 * that keep this a diagnostic — an empty parse is never captured, a failing or
 * dying capture is WARN-logged and yields the inner resources unchanged, and
 * `followUpSteps` still sees only the inner resources.
 *
 * **The body is read through `response.bytes()`, never `text()`.** `text()` is
 * UTF-8 and lossy, and the stored body has to be byte-identical to what arrived
 * for a hash over it to mean anything. Note also that the trace captures the
 * **raw** bytes, not the `extractJson`-unwrapped string the entity decoded: a
 * body served through the WebView's JSON viewer is stored as the HTML that
 * arrived, because that is what the provenance actually was.
 */
const withProvenance =
  (sessionId: string) =>
  (
    entity: EntityDefinition.EntityDefinition<FhirResource>
  ): EntityDefinition.EntityDefinition<FhirResource> =>
    CapturedSource.withCapturedSource(entity, (response, produced) =>
      Effect.map(
        captureProvenance(
          {
            sessionId,
            requestId: response.id,
            url: response.url,
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
            startedAt: response.startedAt,
            bytes: response.bytes(),
          },
          produced
        ),
        ({ linked, trace }) => [...linked, trace]
      )
    )

/**
 * True for a resource that is one of this collector's traces.
 *
 * @param resource - A resource from a parsed batch
 * @returns Whether it is a web-trace `DocumentReference` rather than clinical
 *   output
 *
 * @remarks
 * The `resourceType` test alone would be wrong: a collector could legitimately
 * produce a *clinical* `DocumentReference` one day, and demoting that to a
 * diagnostic would silently drop its write failures out of the run's summary.
 * `isWebTrace` is the category predicate the codec (and the viewer's search)
 * defines, so this asks the same question the rest of the slice asks.
 */
const isTraceResource = (resource: FhirResource): boolean =>
  resource.resourceType === 'DocumentReference' && isWebTrace(resource)

export { isTraceResource, mintRunId, withProvenance }
