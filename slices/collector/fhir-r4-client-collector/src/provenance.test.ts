import {
  DiagnosticResources,
  type EntityDefinition,
  type Response,
} from 'collector-fundamentals/model'
import { makeRemoteResponse } from 'collector-fundamentals/test-helpers'
import { Effect, Encoding, Schema } from 'effect'
import * as fc from 'fast-check'
import { DocumentReference } from 'fhir-r4/resources'
import type { FhirResource } from 'fhir-r4/resources'
import { LoggingLayerTest, numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it, vi } from 'vite-plus/test'
import type { DocumentReferenceType } from 'web-trace-core/codec'
import { fromDocumentReference } from 'web-trace-core/codec'

import { ObservationEntity } from './entities/observation-entity.ts'
import { ObservationListEntity } from './entities/observation-list-entity.ts'
import { PatientEntity } from './entities/patient-entity.ts'
import { isTraceResource, mintRunId, withProvenance } from './provenance.ts'

/**
 * The run id every trace in this suite shares. Fixed rather than minted, so an
 * expected `DocumentReference/{sessionId}-{requestId}` back-link is writable by
 * hand — `mintRunId`'s freshness is its own test below.
 */
const RUN_ID = 'fhir-r4-test-run'

const capture = withProvenance(RUN_ID)
const CapturingPatientEntity = capture(PatientEntity)
const CapturingObservationEntity = capture(ObservationEntity)
const CapturingObservationListEntity = capture(ObservationListEntity)

const PATIENT_URL = 'https://example.com/Patient/p1?_format=json'
const OBSERVATION_URL = 'https://example.com/Observation/obs-1'
const OBSERVATION_LIST_URL = 'https://example.com/Observation?_count=250'

const utf8 = new TextEncoder()

const parse = (
  entity: EntityDefinition.EntityDefinition<FhirResource>,
  response: Response.RemoteResponse
): Promise<readonly FhirResource[]> => Effect.runPromise(entity.parse(response))

const isDocumentReference = (resource: FhirResource): resource is DocumentReferenceType =>
  resource.resourceType === 'DocumentReference'

/** The single trace in a parsed batch; fails the test if there is not exactly one. */
const onlyTrace = (resources: readonly FhirResource[]): DocumentReferenceType => {
  const traces = resources.filter(isDocumentReference)
  expect(traces).toHaveLength(1)
  const trace = traces[0]
  if (trace === undefined) throw new Error('no trace was captured')
  return trace
}

/** The base64 the trace actually stored for a batch's one trace. */
const storedData = (resources: readonly FhirResource[]): string | null | undefined =>
  onlyTrace(resources).content[0]?.attachment.data

/** A minimal FHIR `Patient` wire object, optionally padded to a chosen size. */
const patientJson = (id: string | null, padTo = 0): string =>
  JSON.stringify({
    resourceType: 'Patient',
    ...(id === null ? {} : { id }),
    // `name.family` is a plain string, so padding here stays inside the schema
    // rather than relying on how excess properties are treated.
    ...(padTo === 0 ? {} : { name: [{ family: 'a'.repeat(padTo) }] }),
  })

/** A minimal FHIR `Observation` wire object (required: resourceType, status, code). */
const observationJson = (id: string): Record<string, unknown> => ({
  resourceType: 'Observation',
  id,
  status: 'final',
  code: { text: 'Heart rate' },
})

const bundleJson = (...resources: readonly unknown[]): string =>
  JSON.stringify({
    resourceType: 'Bundle',
    type: 'searchset',
    entry: resources.map((resource) => ({ resource })),
  })

const patientResponse = (body: string | Uint8Array, id = 'req-1'): Response.RemoteResponse =>
  makeRemoteResponse({
    id,
    url: PATIENT_URL,
    headers: [['content-type', 'application/fhir+json']],
    body,
  })

describe('mintRunId', () => {
  it('is fresh per call, so one run cannot upsert over the previous run traces', () => {
    // The trace resource id is `{runId}-{requestId}`; a stable run id would make
    // a second sync of the same remote overwrite the first sync's traces.
    const ids = new Set(Array.from({ length: 50 }, () => mintRunId()))
    expect(ids.size).toBe(50)
  })

  it('names the collector that produced the trace', () => {
    expect(mintRunId()).toMatch(
      /^fhir-r4-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )
  })
})

describe('withProvenance', () => {
  describe('every response that produced a resource is captured, body verbatim', () => {
    it('stores the exact bytes that arrived alongside the resource they produced', async () => {
      const body = patientJson('p1')
      const resources = await parse(CapturingPatientEntity, patientResponse(body))

      expect(resources.map((resource) => resource.resourceType)).toEqual([
        'Patient',
        'DocumentReference',
      ])
      expect(storedData(resources)).toBe(Encoding.encodeBase64(utf8.encode(body)))
    })

    // The guardrail this pins: the capture reads `bytes()`, never `text()`.
    // `text()` is UTF-8 and lossy, so a re-encode of it is not the body that
    // arrived — and a hash over the stored data would then mean nothing.
    it('stores a body that is not valid UTF-8 as it arrived, not as a UTF-8 round-trip', async () => {
      const head = utf8.encode('{"resourceType":"Patient","id":"p1","name":[{"family":"')
      const invalid = Uint8Array.from([0xff, 0xfe, 0xfd])
      const tail = utf8.encode('"}]}')
      const bytes = new Uint8Array(head.length + invalid.length + tail.length)
      bytes.set(head, 0)
      bytes.set(invalid, head.length)
      bytes.set(tail, head.length + invalid.length)

      const response = patientResponse(bytes)
      const resources = await parse(CapturingPatientEntity, response)

      // The entity still decoded a Patient (its `text()` read replaced the
      // undecodable bytes), and the trace still holds the raw ones.
      expect(resources.map((resource) => resource.resourceType)).toEqual([
        'Patient',
        'DocumentReference',
      ])
      expect(storedData(resources)).toBe(Encoding.encodeBase64(bytes))
      expect(storedData(resources)).not.toBe(Encoding.encodeBase64(utf8.encode(response.text())))
    })

    // No allowlist and no truncation: the recorder's 1 MiB cap is a recording
    // policy, and a body that justifies a clinical resource *is* the provenance.
    it('stores a body larger than the recorder 1 MiB cap in full', async () => {
      const body = patientJson('p1', 1024 * 1024)
      expect(body.length).toBeGreaterThan(1024 * 1024)

      const resources = await parse(CapturingPatientEntity, patientResponse(body))
      const attachment = onlyTrace(resources).content[0]?.attachment

      expect(attachment?.size).toBe(utf8.encode(body).length)
      expect(attachment?.data).toBe(Encoding.encodeBase64(utf8.encode(body)))
    })
  })

  describe('a response that produced no resource is not captured', () => {
    // This is the line between deliberate provenance collection and bulk
    // recording, so it is driven through the collector's real empty-parse paths
    // rather than a stub entity.
    it('skips a Patient with no id, which PatientEntity drops', async () => {
      const resources = await parse(CapturingPatientEntity, patientResponse(patientJson(null)))
      expect(resources).toEqual([])
    })

    it('skips an empty Observation bundle', async () => {
      const resources = await parse(
        CapturingObservationListEntity,
        makeRemoteResponse({ url: OBSERVATION_LIST_URL, body: bundleJson() })
      )
      expect(resources).toEqual([])
    })

    it('skips a bundle whose entries all carry no resource', async () => {
      // The search-outcome / request-only entries `ObservationListEntity`
      // drops-and-counts: the bundle decoded fine, it just yielded nothing.
      const resources = await parse(
        CapturingObservationListEntity,
        makeRemoteResponse({
          url: OBSERVATION_LIST_URL,
          body: JSON.stringify({
            resourceType: 'Bundle',
            type: 'searchset',
            entry: [{ fullUrl: 'https://example.com/Observation/gone' }],
          }),
        })
      )
      expect(resources).toEqual([])
    })
  })

  describe('the provenance link is navigable in both directions', () => {
    it('names every produced resource in the trace, and the trace on every resource', async () => {
      const body = patientJson('p1')
      const resources = await parse(CapturingPatientEntity, patientResponse(body, 'req-42'))

      // Asserted through the codec, so it is the round-trip under test rather
      // than the encoded shape.
      const exchange = await Effect.runPromise(fromDocumentReference(onlyTrace(resources)))
      expect(exchange.producedResources).toEqual(['Patient/p1'])
      expect(exchange.sessionId).toBe(RUN_ID)
      expect(exchange.requestId).toBe('req-42')
      expect(exchange.url).toBe(PATIENT_URL)
      expect(exchange.body).toMatchObject({
        _tag: 'StoredBody',
        data: Encoding.encodeBase64(utf8.encode(body)),
      })

      const patient = resources.find((resource) => resource.resourceType === 'Patient')
      expect(patient?.meta?.source).toBe(`DocumentReference/${RUN_ID}-req-42`)
    })

    it('names every resource of a multi-resource batch', async () => {
      const resources = await parse(
        CapturingObservationListEntity,
        makeRemoteResponse({
          url: OBSERVATION_LIST_URL,
          body: bundleJson(observationJson('obs-1'), observationJson('obs-2')),
        })
      )

      const exchange = await Effect.runPromise(fromDocumentReference(onlyTrace(resources)))
      expect(exchange.producedResources).toEqual(['Observation/obs-1', 'Observation/obs-2'])
      expect(
        resources
          .filter((resource) => resource.resourceType === 'Observation')
          .map((resource) => resource.meta?.source)
      ).toEqual([`DocumentReference/${RUN_ID}-req-1`, `DocumentReference/${RUN_ID}-req-1`])
    })

    it('property: a resource produced by two responses in one run is named by both traces', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.tuple(fc.uuid(), fc.uuid()),
          fc.string({ minLength: 1, maxLength: 16 }).filter((id) => /^[A-Za-z0-9\-.]+$/.test(id)),
          async ([listRequestId, detailRequestId], observationId) => {
            fc.pre(listRequestId !== detailRequestId)
            const fromList = await parse(
              CapturingObservationListEntity,
              makeRemoteResponse({
                id: listRequestId,
                url: OBSERVATION_LIST_URL,
                body: bundleJson(observationJson(observationId)),
              })
            )
            const fromDetail = await parse(
              CapturingObservationEntity,
              makeRemoteResponse({
                id: detailRequestId,
                url: OBSERVATION_URL,
                body: JSON.stringify(observationJson(observationId)),
              })
            )

            const listTrace = onlyTrace(fromList)
            const detailTrace = onlyTrace(fromDetail)
            expect(listTrace.id).not.toBe(detailTrace.id)

            // `context.related` is the direction that survives several sources;
            // `meta.source` is a single FHIR uri and holds only the last writer.
            const exchanges = await Promise.all(
              [listTrace, detailTrace].map((trace) =>
                Effect.runPromise(fromDocumentReference(trace))
              )
            )
            for (const exchange of exchanges) {
              expect(exchange.producedResources).toEqual([`Observation/${observationId}`])
              expect(exchange.sessionId).toBe(RUN_ID)
            }
          }
        ),
        { numRuns: numRunsFor({ base: 25 }) }
      )
    })
  })

  describe('the capture never changes what the entity produced', () => {
    it('leaves the clinical resources exactly what the inner entity decoded, bar the back-link', async () => {
      const response = patientResponse(patientJson('p1'))
      const wrapped = await parse(CapturingPatientEntity, response)
      const bare = await parse(PatientEntity, response)

      // Everything outside `meta` is untouched — the capture is a diagnostic and
      // must not alter the collector's primary output.
      const withoutMeta = (resources: readonly FhirResource[]): readonly FhirResource[] =>
        resources
          .filter((resource) => !isDocumentReference(resource))
          .map((resource) => ({ ...resource, meta: null }))
      expect(withoutMeta(wrapped)).toEqual(withoutMeta(bare))
      // ...and `meta` gained exactly the back-link.
      expect(wrapped[0]?.meta?.source).toBe(`DocumentReference/${RUN_ID}-req-1`)
      expect(bare[0]?.meta).toBeNull()
    })

    it('passes the entity name and isFoundAt through untouched', () => {
      expect(CapturingPatientEntity.name).toBe(PatientEntity.name)
      expect(CapturingPatientEntity.isFoundAt(PATIENT_URL)).toBe(true)
      expect(CapturingPatientEntity.isFoundAt(OBSERVATION_LIST_URL)).toBe(false)
    })
  })
})

describe('isTraceResource', () => {
  it('is true for a captured trace', async () => {
    const resources = await parse(CapturingPatientEntity, patientResponse(patientJson('p1')))
    expect(resources.filter(isTraceResource).map((resource) => resource.resourceType)).toEqual([
      'DocumentReference',
    ])
  })

  // A bare `resourceType === 'DocumentReference'` test would silently demote a
  // clinical document to a diagnostic, hiding its failed write from the run.
  it('is false for a clinical DocumentReference', () => {
    const clinical = Schema.decodeUnknownSync(DocumentReference.Schema)({
      resourceType: 'DocumentReference',
      id: 'discharge-summary-1',
      status: 'current',
      content: [{ attachment: { contentType: 'application/pdf' } }],
    })
    expect(isTraceResource(clinical)).toBe(false)
  })

  it('is false for the clinical resources a collector produces', async () => {
    const resources = await parse(CapturingPatientEntity, patientResponse(patientJson('p1')))
    expect(resources.filter((resource) => !isTraceResource(resource))).toHaveLength(1)
  })
})

describe('the descriptor write path', () => {
  const failureFor = (resource: FhirResource): { failed: { label: string; id: string } } => ({
    failed: { label: resource.resourceType, id: resource.id ?? '<no-id>' },
  })

  it('keeps a failed trace write out of the run reported failures, and writes the clinical half first', async () => {
    const resources = await parse(CapturingPatientEntity, patientResponse(patientJson('p1')))

    // A sink that refuses exactly the traces. Without `withDiagnosticResources`
    // this would surface as a `PersistFailure` and downgrade a clean run to
    // `partial` in `collector-react`'s import summary.
    const sink = vi.fn<DiagnosticResources.PersistResources<FhirResource, never>>((batch) =>
      Effect.succeed(
        batch
          .filter(isTraceResource)
          .map((resource) => ({ ...failureFor(resource), cause: new Error('trace write refused') }))
      )
    )

    const failures = await Effect.runPromise(
      DiagnosticResources.withDiagnosticResources(
        sink,
        isTraceResource
      )(resources).pipe(
        LoggingLayerTest.expectToLog((logs) => {
          const warnings = logs.filter((log) => log.level === 'WARN')
          expect(warnings).toHaveLength(1)
          expect(warnings[0]?.message).toContain('DocumentReference')
        }),
        Effect.scoped
      )
    )

    expect(failures).toEqual([])
    expect(
      sink.mock.calls.map(([batch]) => batch.map((resource) => resource.resourceType))
    ).toEqual([['Patient'], ['DocumentReference']])
  })

  it('still reports a failed clinical write', async () => {
    const resources = await parse(CapturingPatientEntity, patientResponse(patientJson('p1')))
    const sink = vi.fn<DiagnosticResources.PersistResources<FhirResource, never>>((batch) =>
      Effect.succeed(
        batch.map((resource) => ({ ...failureFor(resource), cause: new Error('store offline') }))
      )
    )

    const failures = await Effect.runPromise(
      DiagnosticResources.withDiagnosticResources(
        sink,
        isTraceResource
      )(resources).pipe(
        LoggingLayerTest.expectToLog(() => {}),
        Effect.scoped
      )
    )

    expect(failures.map((failure) => failure.failed.label)).toEqual(['Patient'])
  })
})
