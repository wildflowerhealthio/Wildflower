import { HttpClient, HttpClientResponse } from '@effect/platform'
import { QueryClient } from '@tanstack/react-query'
import { Effect, Layer, pipe, SubscriptionRef } from 'effect'
import type { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import { BearerToken } from 'kitchen-sink/auth-token'
import { afterEach, describe, expect, test } from 'vite-plus/test'

import { sliceRuntimeLayer } from '../router-context.ts'
import { PATIENTS_QUERY_KEY, patientsQueryOptions, type RunAuthed } from './index.ts'

/**
 * Drives the FHIR `patientsQueryOptions` over the real
 * runner → fhir-layer → HttpClient path, with a stub HttpClient that
 * returns a canned `Patient` searchset bundle. Mirrors
 * `gatekeeper-react`'s `queries.test.ts` — the slice owns its own
 * `runAuthed` builder locally so the test has no app dependency.
 */

// Minimal valid `searchset` Bundle of two Patients — the decode tracks
// `Bundle.Schema(Patient.Schema)`; optional/defaulted Patient fields are
// omitted intentionally so the test pins only the id/name path the
// flatten reads.
const PATIENT_BUNDLE = {
  resourceType: 'Bundle',
  type: 'searchset',
  entry: [
    {
      resource: {
        resourceType: 'Patient',
        id: 'pat-1',
        name: [{ given: ['Ada'], family: 'Lovelace' }],
      },
    },
    { resource: { resourceType: 'Patient', id: 'pat-2' } },
  ],
}

// A bundle whose single entry has no resource — the flatten must drop it.
const EMPTY_ENTRY_BUNDLE = {
  resourceType: 'Bundle',
  type: 'searchset',
  entry: [{}],
}

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

// `failing: true` always 500s — exercises the query's error path.
const stubHttpClientLayer = (options?: {
  readonly body?: unknown
  readonly failing?: boolean
}): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          options?.failing === true
            ? new Response(null, { status: 500 })
            : jsonResponse(options?.body ?? { resourceType: 'Bundle', type: 'searchset' })
        )
      )
    )
  )

const disposers: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()))
})

// Mirrors the app's `buildRunAuthed`; kept local so the slice has no app dep.
const makeRunAuthed = (httpLayer: Layer.Layer<HttpClient.HttpClient>): RunAuthed => {
  const tokenRef = Effect.runSync(SubscriptionRef.make<string | null>('token'))
  return <A, E>(
    effect: Effect.Effect<A, E, BearerToken | HttpClient.HttpClient | FhirR4ResourcesHttpApiClient>
  ): Promise<A> =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(
          pipe(
            sliceRuntimeLayer,
            Layer.provideMerge(httpLayer),
            Layer.provideMerge(Layer.succeed(BearerToken, tokenRef))
          )
        ),
        Effect.scoped
      )
    )
}

const freshQueryClient = (): QueryClient => {
  const queryClient = new QueryClient()
  disposers.push(() => Promise.resolve(queryClient.clear()))
  return queryClient
}

describe('patientsQueryOptions', () => {
  test('exposes the canonical PATIENTS_QUERY_KEY', () => {
    const options = patientsQueryOptions(makeRunAuthed(stubHttpClientLayer()))
    expect(options.queryKey).toEqual(PATIENTS_QUERY_KEY)
  })

  test('queryFn reads the patient list through the authed runner and flattens the bundle', async () => {
    const options = patientsQueryOptions(
      makeRunAuthed(stubHttpClientLayer({ body: PATIENT_BUNDLE }))
    )
    const queryClient = freshQueryClient()

    const patients = await queryClient.ensureQueryData(options)

    expect(patients).toHaveLength(2)
    expect(patients.map((p) => p.id)).toEqual(['pat-1', 'pat-2'])
    expect(queryClient.getQueryData(PATIENTS_QUERY_KEY)).toEqual(patients)
  })

  test('drops entries with no resource', async () => {
    const options = patientsQueryOptions(
      makeRunAuthed(stubHttpClientLayer({ body: EMPTY_ENTRY_BUNDLE }))
    )
    const queryClient = freshQueryClient()

    const patients = await queryClient.ensureQueryData(options)

    expect(patients).toHaveLength(0)
  })

  test('a failed read rejects ensureQueryData (propagates to the caller)', async () => {
    const options = patientsQueryOptions(makeRunAuthed(stubHttpClientLayer({ failing: true })))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    disposers.push(() => Promise.resolve(queryClient.clear()))

    await expect(queryClient.ensureQueryData(options)).rejects.toThrow()
    expect(queryClient.getQueryData(PATIENTS_QUERY_KEY)).toBeUndefined()
  })
})
