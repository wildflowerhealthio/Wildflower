import { HttpClient, HttpClientRequest, HttpClientResponse } from '@effect/platform'
import { Arbitrary, Effect, FastCheck as fc, Layer, Option, Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { Patient, type FhirResource } from '../resources/index.ts'
import {
  classifyAgainstServer,
  diffKey,
  resetFieldToServer,
  SERVER_MANAGED_META_FIELDS,
  type DiffStatus,
  type ServerComparison,
} from './classify-against-server.ts'
import { FhirR4ResourcesHttpApiClient } from './fhir-r4-resources-http-api-client.ts'
import { formatPath, present } from './field-diff.ts'

/**
 * Covers the existence + content pre-fetch: one `POST /` batch of GET entries,
 * classified per-id as `new` (absent), `unchanged` (server holds a wire-equal
 * copy after dropping server-managed meta), or `changed` (present + differs).
 *
 * Never fails — a whole-bundle failure attributes every id to `new` so the
 * caller's writes still attempt. A resource that returns without a body, or
 * whose body cannot be decoded through the FHIR union, defaults to `changed`
 * rather than silently `unchanged`.
 */
describe('classifyAgainstServer', () => {
  it('classifies an id as new when the server returns 404', async () => {
    const patient = makePatient('nope-1')
    const result = await runWith(
      [patient],
      perEntry(() => ({ status: '404 Not Found' }))
    )
    expect(result.classifications.get(diffKey(patient))?.status).toBe<DiffStatus>('new')
  })

  it('classifies an id as unchanged when the server returns a byte-equal resource (minus server-managed meta)', async () => {
    const patient = makePatient('same-1')
    // The server echoes the same wire-form patient plus versionId/lastUpdated /
    // source — all three are in SERVER_MANAGED_META_FIELDS, so the classifier
    // must ignore them.
    const wire = encodePatient(patient)
    const echoed = withServerManagedMetaWire(wire)
    const result = await runWith(
      [patient],
      perEntry(() => ({ status: '200 OK', resource: echoed }))
    )
    const comparison = result.classifications.get(diffKey(patient))
    expect(comparison?.status).toBe<DiffStatus>('unchanged')
    // The server copy is carried even when nothing differs, so a later edit
    // to this resource can be diffed against it.
    expect(comparison?.server).toBeDefined()
  })

  it('classifies an id as changed when the returned resource differs on non-meta content', async () => {
    const patient = makePatient('drift-1')
    const drifted = { ...patient, gender: patient.gender === 'male' ? 'female' : 'male' } as const
    const result = await runWith(
      [patient],
      perEntry(() => ({ status: '200 OK', resource: encodePatient(drifted) }))
    )
    expect(result.classifications.get(diffKey(patient))?.status).toBe<DiffStatus>('changed')
  })

  it('carries the leaf-level field diffs (server value) for a changed resource', async () => {
    // Arrange: the server holds a copy that differs only on gender.
    const patient = makePatient('drift-fields')
    const serverGender = patient.gender === 'female' ? 'male' : 'female'
    const onServer = { ...patient, gender: serverGender } as const

    // Act
    const result = await runWith(
      [patient],
      perEntry(() => ({ status: '200 OK', resource: encodePatient(onServer) }))
    )

    // Assert: the changed status names the gender leaf, showing the server's value.
    const comparison = result.classifications.get(diffKey(patient))
    expect(comparison?.status).toBe<DiffStatus>('changed')
    const genderDiff = comparison?.fields.find((field) => formatPath(field.path) === 'gender')
    expect(genderDiff?.server).toEqual(present(serverGender))
  })

  it('classifies as new when the whole submission fails, so writes still attempt', async () => {
    const patient = makePatient('svc-out')
    const result = await runWith([patient], rawResponse(new Response('', { status: 503 })))
    expect(result.classifications.get(diffKey(patient))?.status).toBe<DiffStatus>('new')
  })

  it('classifies as changed when the server returns 2xx with no body', async () => {
    const patient = makePatient('bodyless-1')
    const result = await runWith(
      [patient],
      perEntry(() => ({ status: '200 OK' }))
    )
    expect(result.classifications.get(diffKey(patient))?.status).toBe<DiffStatus>('changed')
  })

  it('classifies as changed when the returned resource is not decodable through the FHIR union', async () => {
    const patient = makePatient('bogus-1')
    const result = await runWith(
      [patient],
      perEntry(() => ({
        status: '200 OK',
        // Not a supported resource type in FhirResourceSchema.
        resource: { resourceType: 'Organization', id: 'nope' },
      }))
    )
    expect(result.classifications.get(diffKey(patient))?.status).toBe<DiffStatus>('changed')
  })

  it('skips null-id resources and returns nothing for them', async () => {
    const result = await runWith(
      [makePatient(null)],
      perEntry(() => ({ status: '200 OK' }))
    )
    expect(result.requests).toEqual([])
    expect(result.classifications.size).toBe(0)
  })

  it('never issues a request for an empty batch', async () => {
    const result = await runWith(
      [],
      perEntry(() => ({ status: '404' }))
    )
    expect(result.requests).toEqual([])
    expect(result.classifications.size).toBe(0)
  })

  it('sends one Bundle{type:batch} of GET entries addressed by Type/id', async () => {
    const patient = makePatient('probe-1')
    const result = await runWith(
      [patient],
      perEntry(() => ({ status: '404 Not Found' }))
    )
    expect(result.requests).toHaveLength(1)
    const [request] = result.requests
    expect(request?.method).toBe('POST')
    expect(request?.body.type).toBe('batch')
    expect(request?.body.entry?.[0]?.request?.method).toBe('GET')
    expect(request?.body.entry?.[0]?.request?.url).toBe('Patient/probe-1')
  })
})

describe('SERVER_MANAGED_META_FIELDS', () => {
  it('lists the three fields the classifier drops before comparing', () => {
    expect(SERVER_MANAGED_META_FIELDS).toEqual(['versionId', 'lastUpdated', 'source'])
  })
})

describe('diffKey', () => {
  it('joins resourceType and logical id with a slash', () => {
    expect(diffKey(makePatient('p-1'))).toBe('Patient/p-1')
  })
})

describe('resetFieldToServer', () => {
  it('replaces one leaf of the incoming resource with the server value', () => {
    // Arrange: a gender leaf that differs from the server.
    const patient = makePatient('reset-1')
    const serverGender = patient.gender === 'female' ? 'male' : 'female'
    const field = {
      path: ['gender'] as const,
      server: present(serverGender),
      incoming: present(patient.gender),
    }

    // Act
    const reset = resetFieldToServer(patient, field)

    // Assert: a decodable resource with just that leaf now matching the server.
    expect(Option.isSome(reset)).toBe(true)
    if (Option.isSome(reset)) {
      expect(reset.value).toMatchObject({ resourceType: 'Patient', gender: serverGender })
    }
  })

  it('leaves the incoming resource unedited on the rest of its content', () => {
    // Arrange
    const patient = makePatient('reset-2')
    const serverGender = patient.gender === 'female' ? 'male' : 'female'
    const field = {
      path: ['gender'] as const,
      server: present(serverGender),
      incoming: present(patient.gender),
    }

    // Act
    const reset = resetFieldToServer(patient, field)

    // Assert: the id (and therefore the resource's identity) is untouched.
    if (Option.isSome(reset)) expect(reset.value.id).toBe(patient.id)
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
    readonly request?: { readonly method?: string; readonly url?: string } | null
  }[]
}

const parseBody = (raw: string): RecordedBundle => {
  if (raw === '') return {}
  const parsed: unknown = JSON.parse(raw)
  if (parsed === null || typeof parsed !== 'object') return {}
  return parsed
}

const genWithId = <A extends FhirResource, I>(
  schema: Schema.Schema<A, I>,
  id: string | null
): A => {
  const value = fc.sample(Arbitrary.make(schema), { numRuns: 1, seed: 11 })[0]
  if (value === undefined) throw new Error('unreachable: one sample requested')
  return { ...value, id }
}

type PatientType = Extract<FhirResource, { readonly resourceType: 'Patient' }>

const makePatient = (id: string | null): PatientType => genWithId(Patient.Schema, id)

const encodePatient = Schema.encodeSync(Patient.Schema)

/**
 * Add server-managed `meta` fields to a wire-form patient — the classifier
 * must ignore these three fields when deciding `unchanged`, so an echoed copy
 * that carries them must still classify as `unchanged`.
 */
const withServerManagedMetaWire = (wire: object): object => ({
  ...wire,
  meta: {
    ...('meta' in wire && typeof wire.meta === 'object' ? wire.meta : {}),
    versionId: '42',
    lastUpdated: '2026-01-01T00:00:00.000Z',
    source: 'DocumentReference/some-other',
  },
})

type EntryOverride = { readonly status: string; readonly resource?: unknown }

type Responder = (body: RecordedBundle) => Response

const bundleWith = (entries: readonly EntryOverride[]): Response =>
  new Response(
    JSON.stringify({
      resourceType: 'Bundle',
      type: 'batch-response',
      entry: entries.map((entry) => ({
        response: { status: entry.status },
        ...(entry.resource !== undefined ? { resource: entry.resource } : {}),
      })),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  )

const perEntry =
  (entryFor: (index: number) => EntryOverride): Responder =>
  (body) =>
    bundleWith((body.entry ?? []).map((_, index) => entryFor(index)))

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
  readonly classifications: ReadonlyMap<string, ServerComparison>
}> => {
  const records: Array<RecordedRequest> = []
  const clientLayer = FhirR4ResourcesHttpApiClient.layer.pipe(
    Layer.provide(recordingHttpClientLayer(records, responder))
  )
  const classifications = await Effect.runPromise(
    classifyAgainstServer(resources).pipe(Effect.provide(clientLayer))
  )
  return { requests: records, classifications }
}
