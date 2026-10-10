import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from '@effect/platform'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Arbitrary, Effect, Either, FastCheck as fc, Layer, Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { FhirResourceSchema, Patient, Observation, type FhirResource } from '../resources/index.ts'
import { FhirR4ResourcesHttpApiClient } from './fhir-r4-resources-http-api-client.ts'
import {
  BatchEntriesRejected,
  type BatchEntryOutcome,
  entryUrl,
  groupByStatus,
  NO_RESPONSE_STATUS,
  persistBatchBundle,
  persistBatchBundleOrFail,
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

  it('posts each resource in its encoded wire form, with no null choice slots', async () => {
    // A decoded Observation holds every unset `effective[x]` as `null`; posted
    // as is, HFS reads `Observation.effective` as the null `effectiveDateTime`
    // and indexes no `date` for the period.
    const observation = Schema.decodeUnknownSync(Observation.Schema)({
      resourceType: 'Observation',
      id: 'hr-1',
      status: 'final',
      code: { coding: [{ system: 'http://loinc.org', code: '8867-4' }] },
      effectivePeriod: { start: '2026-09-10T14:00:00.000Z', end: '2026-09-10T15:00:00.000Z' },
    })
    const captured = await runWith([observation], allOk)

    const posted = captured.requests[0]?.body.entry?.[0]?.resource
    expect(posted).toEqual(
      JSON.parse(JSON.stringify(Schema.encodeSync(FhirResourceSchema)(observation)))
    )
    expect(posted).toMatchObject({
      effectivePeriod: { start: '2026-09-10T14:00:00.000Z', end: '2026-09-10T15:00:00.000Z' },
    })
    expect(posted).not.toHaveProperty('effectiveDateTime')
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

/**
 * Covers the failing form of the batch write: it succeeds with every outcome
 * when each entry is a 2xx, and otherwise fails naming each rejected entry's
 * target and status — a whole-submission failure rejecting every entry.
 */
describe('persistBatchBundleOrFail', () => {
  it('succeeds with every outcome when each entry is accepted', async () => {
    const result = await runOrFailWith(recordingHttpClientLayer([], allOk), [
      makePatient('p-1'),
      makeObservation('o-1'),
    ])

    expect(result).toEqual(
      Either.right([
        { target: { label: 'Patient', id: 'p-1' }, status: '200 OK', ok: true, issues: [] },
        { target: { label: 'Observation', id: 'o-1' }, status: '200 OK', ok: true, issues: [] },
      ])
    )
  })

  it('fails naming the target and status of a non-2xx entry', async () => {
    const result = await runOrFailWith(
      recordingHttpClientLayer(
        [],
        perEntry((_body, index) => ({
          status: index === 1 ? '422 Unprocessable Entity' : '200 OK',
        }))
      ),
      [makePatient('p-1'), makeObservation('o-1')]
    )

    expect(result._tag).toBe('Left')
    if (result._tag !== 'Left') return
    expect(result.left).toBeInstanceOf(BatchEntriesRejected)
    expect(result.left.submittedCount).toBe(2)
    expect(result.left.rejected.map((outcome) => [outcome.target, outcome.status])).toEqual([
      [{ label: 'Observation', id: 'o-1' }, '422 Unprocessable Entity'],
    ])
    expect(result.left.message).toBe(
      '1 of 2 batch entries were rejected: Observation/o-1 (422 Unprocessable Entity)'
    )
  })

  it('fails rejecting every entry when the submission never reaches the server', async () => {
    const result = await runOrFailWith(failingTransportLayer, [
      makePatient('p-1'),
      makeObservation('o-1'),
    ])

    expect(result._tag).toBe('Left')
    if (result._tag !== 'Left') return
    expect(result.left.rejected.map((outcome) => [outcome.target.id, outcome.status])).toEqual([
      ['p-1', NO_RESPONSE_STATUS],
      ['o-1', NO_RESPONSE_STATUS],
    ])
  })

  it('property: fails exactly when some entry is not a 2xx, rejecting exactly those entries', async () => {
    // One generated observation, re-keyed per entry: generating a resource is
    // the costly part, and only the statuses vary.
    const sampleObservation = makeObservation('o')
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom('200 OK', '201 Created', '404 Not Found', '500 Server Error'), {
          minLength: 1,
          maxLength: 5,
        }),
        async (statuses) => {
          const resources = statuses.map((_, index) => ({ ...sampleObservation, id: `o-${index}` }))
          const result = await runOrFailWith(
            recordingHttpClientLayer(
              [],
              perEntry((_body, index) => ({ status: statuses[index] ?? '200 OK' }))
            ),
            resources
          )

          const expectedRejectedIds = statuses.flatMap((status, index) =>
            status.startsWith('2') ? [] : [`o-${index}`]
          )
          if (expectedRejectedIds.length === 0) {
            expect(result._tag).toBe('Right')
          } else {
            expect(result._tag).toBe('Left')
            if (result._tag !== 'Left') return
            expect(result.left.rejected.map((outcome) => outcome.target.id)).toEqual(
              expectedRejectedIds
            )
          }
        }
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })
})

describe('groupByStatus', () => {
  const outcome = (id: string, status: string, ok: boolean): BatchEntryOutcome => ({
    target: { label: 'Observation', id },
    status,
    ok,
    issues: [],
  })

  it('groups outcomes by status, failures first, then by ascending code, the sentinel last in its band', () => {
    const outcomes = [
      outcome('a', '200 OK', true),
      outcome('b', NO_RESPONSE_STATUS, false),
      outcome('c', '422 Unprocessable Entity', false),
      outcome('d', '201 Created', true),
      outcome('e', '200 OK', true),
      outcome('f', '404 Not Found', false),
    ]

    const groups = groupByStatus(outcomes)

    expect(groups.map((group) => [group.status, group.ok])).toEqual([
      ['404 Not Found', false],
      ['422 Unprocessable Entity', false],
      [NO_RESPONSE_STATUS, false],
      ['200 OK', true],
      ['201 Created', true],
    ])
    expect(groups[3]?.outcomes.map((one) => one.target.id)).toEqual(['a', 'e'])
  })

  it('keeps every outcome exactly once', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.string(),
            status: fc.constantFrom('200 OK', '201 Created', '404 Not Found', NO_RESPONSE_STATUS),
          })
        ),
        (rows) => {
          const outcomes = rows.map(({ id, status }) => outcome(id, status, status.startsWith('2')))
          const grouped = groupByStatus(outcomes).flatMap((group) => group.outcomes)
          expect(asMultiset(grouped)).toEqual(asMultiset(outcomes))
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

/** `outcomes` as a sorted list of their JSON, to compare as multisets. */
const asMultiset = (outcomes: readonly BatchEntryOutcome[]): readonly string[] =>
  outcomes.map((outcome) => JSON.stringify(outcome)).toSorted()

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
    readonly resource?: unknown
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

/** An `HttpClient` whose every request fails before reaching a server. */
const failingTransportLayer: Layer.Layer<HttpClient.HttpClient> = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.fail(
      new HttpClientError.RequestError({ request, reason: 'Transport', cause: 'offline' })
    )
  )
)

const runOrFailWith = (
  httpClientLayer: Layer.Layer<HttpClient.HttpClient>,
  resources: ReadonlyArray<FhirResource>
): Promise<Either.Either<ReadonlyArray<BatchEntryOutcome>, BatchEntriesRejected>> =>
  Effect.runPromise(
    persistBatchBundleOrFail(resources).pipe(
      Effect.either,
      Effect.provide(FhirR4ResourcesHttpApiClient.layer.pipe(Layer.provide(httpClientLayer)))
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
