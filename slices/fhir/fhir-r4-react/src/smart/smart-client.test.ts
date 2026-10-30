import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Effect, Exit, Option } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test, vi } from 'vite-plus/test'

import {
  FhirHttpError,
  FhirRequestDropped,
  FhirResponseNotJson,
  smartClientFor,
  type SmartConnection,
} from './smart-client.ts'

/** A redeemed session against `https://fhir.example/r4`, the launch's patient `pat-1`. */
const SESSION: SmartConnection = {
  serverUrl: 'https://fhir.example/r4/',
  accessToken: 'token-1',
  patient: 'pat-1',
}

/**
 * A `fetch` stub answering every request with `respond()`, recording each
 * request it was handed.
 */
const recordingFetch = (
  respond: () => Promise<Response> = () =>
    Promise.resolve(Response.json({ resourceType: 'Bundle' }))
): { readonly fetch: typeof globalThis.fetch; readonly requests: Request[] } => {
  const requests: Request[] = []
  const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
    requests.push(new Request(input, init))
    return respond()
  })
  return { fetch, requests }
}

/** The `Authorization` header each recorded request carried, or `null` for none. */
const authorizationsOf = (requests: readonly Request[]): (string | null)[] =>
  requests.map((request) => request.headers.get('Authorization'))

describe('smartClientFor', () => {
  test('names the server without its trailing slash, the token and the launch patient', () => {
    const client = smartClientFor(SESSION, recordingFetch().fetch)

    expect({
      serverUrl: client.serverUrl,
      accessToken: client.accessToken,
      launchPatientId: client.launchPatientId,
    }).toEqual({
      serverUrl: 'https://fhir.example/r4',
      accessToken: 'token-1',
      launchPatientId: Option.some('pat-1'),
    })
  })

  test.each([undefined, ''])('has no launch patient when the session names %j', (patient) => {
    const client = smartClientFor({ ...SESSION, patient }, recordingFetch().fetch)

    expect(client.launchPatientId).toEqual(Option.none())
  })
})

describe('SmartClient.request', () => {
  test('resolves a relative URL against the FHIR base, with the bearer token', async () => {
    const { fetch, requests } = recordingFetch()
    const client = smartClientFor(SESSION, fetch)

    const body = await Effect.runPromise(client.request('/Patient?_count=200'))

    expect(body).toEqual({ resourceType: 'Bundle' })
    expect(requests.map((request) => request.url)).toEqual([
      'https://fhir.example/r4/Patient?_count=200',
    ])
    expect(authorizationsOf(requests)).toEqual(['Bearer token-1'])
    expect(requests[0]?.headers.get('Accept')).toBe('application/json')
  })

  test('requests an absolute URL under the FHIR base as it is, with the bearer token', async () => {
    const { fetch, requests } = recordingFetch()
    const nextLink = 'https://fhir.example/r4?_getpages=abc&_getpagesoffset=200'

    await Effect.runPromise(smartClientFor(SESSION, fetch).request(nextLink))

    expect(requests.map((request) => request.url)).toEqual([nextLink])
    expect(authorizationsOf(requests)).toEqual(['Bearer token-1'])
  })

  test.each([
    { case: 'another origin', url: 'https://elsewhere.example/r4/Patient' },
    { case: 'another path on the same origin', url: 'https://fhir.example/r4-admin/Patient' },
    { case: 'plain http to the same host', url: 'http://fhir.example/r4/Patient' },
  ])('sends no bearer token to $case', async ({ url }) => {
    const { fetch, requests } = recordingFetch()

    await Effect.runPromise(smartClientFor(SESSION, fetch).request(url))

    expect(requests.map((request) => request.url)).toEqual([url])
    expect(authorizationsOf(requests)).toEqual([null])
  })

  test('sends no Authorization header at all for an open server', async () => {
    const { fetch, requests } = recordingFetch()
    const client = smartClientFor({ ...SESSION, accessToken: undefined }, fetch)

    await Effect.runPromise(client.request('Patient'))

    expect(authorizationsOf(requests)).toEqual([null])
  })

  test('property: an error status fails with FhirHttpError carrying it', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 400, max: 599 }), async (status) => {
        const { fetch } = recordingFetch(() => Promise.resolve(new Response(null, { status })))

        const exit = await Effect.runPromiseExit(smartClientFor(SESSION, fetch).request('Patient'))

        expect(exit).toEqual(
          Exit.fail(new FhirHttpError({ url: 'https://fhir.example/r4/Patient', status }))
        )
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('fails with FhirRequestDropped when no response arrives', async () => {
    const dropped = new TypeError('Failed to fetch')
    const { fetch } = recordingFetch(() => Promise.reject(dropped))

    const exit = await Effect.runPromiseExit(smartClientFor(SESSION, fetch).request('Patient'))

    expect(exit).toEqual(
      Exit.fail(new FhirRequestDropped({ url: 'https://fhir.example/r4/Patient', cause: dropped }))
    )
  })

  test('fails with FhirResponseNotJson when a success carries no JSON', async () => {
    const { fetch } = recordingFetch(() => Promise.resolve(new Response('<html>')))

    const failure = await Effect.runPromise(
      Effect.flip(smartClientFor(SESSION, fetch).request('Patient'))
    )

    expect(failure).toBeInstanceOf(FhirResponseNotJson)
  })
})
