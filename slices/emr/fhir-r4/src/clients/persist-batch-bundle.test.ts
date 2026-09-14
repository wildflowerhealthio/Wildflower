import { HttpClient, HttpClientRequest, HttpClientResponse } from '@effect/platform'
import { Arbitrary, Effect, FastCheck as fc, Layer, type Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { Patient, Observation, type FhirResource } from '../resources/index.ts'
import { FhirR4ResourcesHttpApiClient } from './fhir-r4-resources-http-api-client.ts'
import {
  type BatchEntryOutcome,
  entryUrl,
  NO_RESPONSE_STATUS,
  persistBatchBundle,
} from './persist-batch-bundle.ts'

/**
 * Covers the batch-bundle write — one `POST /` submission carrying N PUT
 * entries — reporting every entry's outcome as data (never raised).
 *
 * - **Wire shape**: the client posts a `Bundle{ type: 'batch' }` at `/` with
 *   one PUT entry per resource, addressed by `Type/id`.
 * - **Per-entry accounting**: each submitted resource gets a
 *   {@link BatchEntryOutcome} — its echoed status, whether that status
 *   succeeded, and any OperationOutcome diagnostics. A whole-bundle failure
 *   (5xx or transport) attributes every resource to that one cause under the
 *   no-response sentinel; a null-id resource is skipped and never touches the
 *   wire.
 */
describe('persistBatchBundle', () => {
  it('posts one Bundle{type:batch} to / with one PUT entry per resource', async () => {
    const captured = await runWith([makePatient('patient-1'), makeObservation('obs-1')], allOk)

    expect(captured.requests).toHaveLength(1)
    const [request] = captured.requests
    expect(request?.method).toBe('POST')
    expect(request?.url).toBe(`${TEST_ORIGIN}/`)
    expect(request?.body.resourceType).toBe('Bundle')
    expect(request?.body.type).toBe('batch')
    expect(request?.body.entry).toHaveLength(2)
    expect(request?.body.entry?.[0]?.request?.method).toBe('PUT')
    expect(request?.body.entry?.[0]?.request?.url).toBe('Patient/patient-1')
    expect(request?.body.entry?.[1]?.request?.url).toBe('Observation/obs-1')
  })

  it('reports one outcome per resource with its echoed status, in submit order', async () => {
    const captured = await runWith(
      [makePatient('p-1'), makeObservation('o-1')],
      perEntry((_body, index) => ({ status: index === 0 ? '201 Created' : '200 OK' }))
    )

    expect(captured.outcomes).toEqual<BatchEntryOutcome[]>([
      { target: { label: 'Patient', id: 'p-1' }, status: '201 Created', ok: true, issues: [] },
      { target: { label: 'Observation', id: 'o-1' }, status: '200 OK', ok: true, issues: [] },
    ])
  })

  it('marks a per-entry non-2xx as not-ok without failing the batch', async () => {
    const captured = await runWith(
      [makePatient('ok-1'), makeObservation('bad-1')],
      perEntry((_body, index) => ({ status: index === 1 ? '404 Not Found' : '200 OK' }))
    )

    expect(captured.outcomes[0]?.ok).toBe(true)
    const failed = captured.outcomes[1]
    expect(failed?.ok).toBe(false)
    expect(failed?.status).toBe('404 Not Found')
    expect(failed?.target).toEqual({ label: 'Observation', id: 'bad-1' })
  })

  it('surfaces the server OperationOutcome diagnostics on a failed entry', async () => {
    const captured = await runWith(
      [makeObservation('ref-1')],
      perEntry(() => ({
        status: '422 Unprocessable Entity',
        outcome: {
          resourceType: 'OperationOutcome',
          issue: [
            { severity: 'error', code: 'invariant', diagnostics: 'Reference Patient/x not found' },
            { severity: 'warning', code: 'processing', details: { text: 'Coding not recognized' } },
          ],
        },
      }))
    )

    expect(captured.outcomes[0]?.issues).toEqual([
      { severity: 'error', code: 'invariant', text: 'Reference Patient/x not found' },
      { severity: 'warning', code: 'processing', text: 'Coding not recognized' },
    ])
  })

  it('attributes every entry to the sentinel status when the whole submission fails', async () => {
    const captured = await runWith(
      [makePatient('a'), makePatient('b')],
      rawResponse(new Response('', { status: 503 }))
    )
    expect(captured.outcomes.map((outcome) => outcome.target.id)).toEqual(['a', 'b'])
    expect(captured.outcomes.every((outcome) => !outcome.ok)).toBe(true)
    expect(captured.outcomes[0]?.status).toBe(NO_RESPONSE_STATUS)
    expect(captured.outcomes[0]?.issues[0]?.severity).toBe('error')
  })

  it('skips a null-id resource without touching the wire', async () => {
    const captured = await runWith([makePatient(null)], allOk)
    expect(captured.requests).toEqual([])
    expect(captured.outcomes).toEqual([])
  })

  it('never issues a request for an empty batch', async () => {
    const captured = await runWith([], allOk)
    expect(captured.requests).toEqual([])
    expect(captured.outcomes).toEqual([])
  })
})

describe('entryUrl', () => {
  it('is the resource type and logical id, joined by a slash', () => {
    expect(entryUrl(makePatient('p-1'))).toBe('Patient/p-1')
    expect(entryUrl(makeObservation('o-2'))).toBe('Observation/o-2')
  })
})

// Helpers

const TEST_ORIGIN = 'http://fhir-r4.test'

interface RecordedRequest {
  readonly method: string
  readonly url: string
  readonly body: RecordedBundle
}

interface RecordedBundle {
  readonly resourceType?: string
  readonly type?: string
  readonly entry?: readonly {
    readonly fullUrl?: string | null
    readonly request?: { readonly method?: string; readonly url?: string } | null
  }[]
}

const parseBody = (raw: string): RecordedBundle => {
  if (raw === '') return {}
  // External JSON parsed at this typed boundary; compared structurally only.
  const parsed: unknown = JSON.parse(raw)
  if (parsed === null || typeof parsed !== 'object') return {}
  return parsed
}

const genWithId = <A extends FhirResource, I>(
  schema: Schema.Schema<A, I>,
  id: string | null
): A => {
  const value = fc.sample(Arbitrary.make(schema), { numRuns: 1, seed: 7 })[0]
  if (value === undefined) throw new Error('unreachable: one sample requested')
  return { ...value, id }
}

const makePatient = (id: string | null): FhirResource => genWithId(Patient.Schema, id)
const makeObservation = (id: string | null): FhirResource => genWithId(Observation.Schema, id)

/** One response entry the stub echoes: a status, and an optional OperationOutcome. */
interface EntryOverride {
  readonly status: string
  readonly outcome?: unknown
}

/** A responder is a function of the request body → the raw Response the stub returns. */
type Responder = (body: RecordedBundle) => Response

const bundleOk = (entries: readonly EntryOverride[]): Response =>
  new Response(
    JSON.stringify({
      resourceType: 'Bundle',
      type: 'batch-response',
      entry: entries.map((entry) => ({
        response: {
          status: entry.status,
          ...(entry.outcome === undefined ? {} : { outcome: entry.outcome }),
        },
      })),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  )

const allOk: Responder = (body) => bundleOk((body.entry ?? []).map(() => ({ status: '200 OK' })))

const perEntry =
  (entryFor: (body: RecordedBundle, index: number) => EntryOverride): Responder =>
  (body) =>
    bundleOk((body.entry ?? []).map((_, index) => entryFor(body, index)))

const rawResponse =
  (response: Response): Responder =>
  () =>
    response

const recordingHttpClientLayer = (
  records: Array<RecordedRequest>,
  responder: Responder
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.mapRequest(
      HttpClient.make((request) => {
        const raw =
          request.body._tag === 'Uint8Array' ? new TextDecoder().decode(request.body.body) : ''
        const body = parseBody(raw)
        records.push({ method: request.method, url: request.url, body })
        return Effect.succeed(HttpClientResponse.fromWeb(request, responder(body).clone()))
      }),
      HttpClientRequest.prependUrl(TEST_ORIGIN)
    )
  )

const runWith = async (
  resources: ReadonlyArray<FhirResource>,
  responder: Responder
): Promise<{
  readonly requests: ReadonlyArray<RecordedRequest>
  readonly outcomes: ReadonlyArray<BatchEntryOutcome>
}> => {
  const records: Array<RecordedRequest> = []
  const clientLayer = FhirR4ResourcesHttpApiClient.layer.pipe(
    Layer.provide(recordingHttpClientLayer(records, responder))
  )
  const outcomes = await Effect.runPromise(
    persistBatchBundle(resources).pipe(Effect.provide(clientLayer))
  )
  return { requests: records, outcomes }
}
