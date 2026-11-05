import { HttpClient, HttpClientRequest, HttpClientResponse } from '@effect/platform'
import type { Query } from '@tanstack/react-query'
import { FhirR4ResourcesHttpApiClient } from '@wildflowerhealthio/fhir-r4/clients'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Effect, Layer, Option } from 'effect'
import fc from 'fast-check'
import { describe, expect, test, vi } from 'vite-plus/test'

import { SmartClient } from './smart-client.ts'
import { decodeFhirBaseUrl } from './smart-connection.ts'
import {
  buildSmartQueryClient,
  buildSmartRouterContext,
  smartHttpClientLayer,
  smartRuntimeFor,
} from './smart-runtime.ts'
import { answerJson, bundleOf, stubConnection, stubFhirServer } from './test-helpers.ts'

/** The FHIR base and token a test sends a request for. */
interface Target {
  readonly fhirBaseUrl: string
  readonly accessToken: string | undefined
}

/**
 * Drive one request through a layer and hand back what actually went on the
 * wire. The inner `HttpClient` is a stub, so nothing leaves the test.
 */
const sendThrough = (
  target: Target,
  request: HttpClientRequest.HttpClientRequest
): Promise<{ readonly url: string; readonly authorization: string | undefined }> => {
  let captured: { readonly url: string; readonly authorization: string | undefined } | null = null
  const stub = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((outgoing) => {
      captured = { url: outgoing.url, authorization: outgoing.headers['authorization'] }
      return Effect.succeed(HttpClientResponse.fromWeb(outgoing, new Response('{}')))
    })
  )
  return Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      yield* client.execute(request)
      return captured ?? { url: '(never sent)', authorization: undefined }
    }).pipe(
      Effect.provide(
        smartHttpClientLayer(
          {
            fhirBaseUrl: decodeFhirBaseUrl(target.fhirBaseUrl),
            accessToken: Option.fromNullable(target.accessToken),
          },
          stub
        )
      )
    )
  )
}

describe('smartHttpClientLayer', () => {
  const session: Target = { fhirBaseUrl: 'http://127.0.0.1:8080', accessToken: 'tok-123' }

  test('addresses a relative client path at the FHIR server and attaches the token', async () => {
    const sent = await sendThrough(session, HttpClientRequest.get('/DocumentReference'))
    expect(sent.url).toBe('http://127.0.0.1:8080/DocumentReference')
    expect(sent.authorization).toBe('Bearer tok-123')
  })

  // The client emits base-relative paths, so the base is whatever server
  // the handshake named — a sandbox base with its own subpath, an EHR's `iss`,
  // anything. It is prepended verbatim (trailing slashes trimmed) rather than
  // parsed, so any of these addresses correctly.
  test('prepends an arbitrary server base verbatim', async () => {
    const sent = await sendThrough(
      { fhirBaseUrl: 'https://launch.smarthealthit.org/v/r4/fhir', accessToken: undefined },
      HttpClientRequest.get('/Patient')
    )
    expect(sent.url).toBe('https://launch.smarthealthit.org/v/r4/fhir/Patient')
  })

  test('property: any server base is prepended to a relative path', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.webUrl({ withQueryParameters: false, withFragments: false }),
        fc.nat({ max: 3 }),
        async (origin: string, extraSlashes: number) => {
          const base = origin.replace(/\/+$/u, '')
          // A trailing-slash-carrying `serverUrl` must address identically: only
          // trailing slashes are trimmed before the URL parser reads the base.
          const serverUrl = `${base}${'/'.repeat(extraSlashes)}`
          const sent = await sendThrough(
            { fhirBaseUrl: serverUrl, accessToken: undefined },
            HttpClientRequest.get('/Patient')
          )
          expect(sent.url).toBe(new URL(`${base}/Patient`).href)
        }
      ),
      { numRuns: numRunsFor({ base: 40 }) }
    )
  })

  // Prepending to an absolute URL yields `http://a…http://b…`, which `fetch`
  // then resolves against the page origin — corruption, not a failure.
  test('leaves an already-absolute URL alone', async () => {
    const sent = await sendThrough(session, HttpClientRequest.get('https://elsewhere.test/thing'))
    expect(sent.url).toBe('https://elsewhere.test/thing')
  })

  test('sets no Authorization header at all when there is no token', async () => {
    const sent = await sendThrough(
      { ...session, accessToken: undefined },
      HttpClientRequest.get('/DocumentReference')
    )
    expect(sent.authorization).toBeUndefined()
  })

  test('addresses a path with no leading slash under the FHIR server too', async () => {
    const sent = await sendThrough(
      { fhirBaseUrl: 'https://launch.smarthealthit.org/v/r4/fhir/', accessToken: undefined },
      HttpClientRequest.get('Patient?_count=200')
    )
    expect(sent.url).toBe('https://launch.smarthealthit.org/v/r4/fhir/Patient?_count=200')
  })

  // A search bundle's `next` link is absolute and names the FHIR server, so it
  // is the same session's read and must carry the same credential.
  test('attaches the token to an absolute URL under the FHIR base', async () => {
    const nextLink = 'http://127.0.0.1:8080/Patient?_getpages=abc&_getpagesoffset=200'
    const sent = await sendThrough(session, HttpClientRequest.get(nextLink))
    expect(sent).toEqual({ url: nextLink, authorization: 'Bearer tok-123' })
  })

  test.each([
    { case: 'another origin', url: 'https://elsewhere.example/r4/Patient' },
    { case: 'another path on the same origin', url: 'https://fhir.example/r4-admin/Patient' },
    { case: 'plain http to the same host', url: 'http://fhir.example/r4/Patient' },
  ])('sends no token to $case', async ({ url }) => {
    const sent = await sendThrough(
      { fhirBaseUrl: 'https://fhir.example/r4', accessToken: 'tok-123' },
      HttpClientRequest.get(url)
    )
    expect(sent).toEqual({ url, authorization: undefined })
  })

  test('a token is never sent to an origin the session did not name', async () => {
    const sent = await sendThrough(session, HttpClientRequest.get('https://elsewhere.test/thing'))
    // Two halves of the same claim: an absolute URL is neither silently
    // re-addressed to the FHIR server, nor handed the credential that server
    // issued. The session granted a token for its own origin only.
    expect(sent.url).not.toContain('127.0.0.1:8080')
    expect(sent.authorization).toBeUndefined()
  })
})

/** A transport no test in this block sends anything through. */
const deadTransport = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() => Effect.die(new Error('no request expected')))
)

describe('smartRuntimeFor', () => {
  test('runs the SmartClient and the typed client over the one transport, both addressed', async () => {
    const server = stubFhirServer({
      'Patient/p1': answerJson({ resourceType: 'Patient', id: 'p1' }),
      Observation: answerJson(bundleOf([])),
    })
    const runtime = smartRuntimeFor(
      stubConnection({ accessToken: Option.some('tok-123') }),
      server.transport
    )

    await runtime.runSmart(
      Effect.gen(function* () {
        const smartClient = yield* SmartClient
        yield* smartClient.request('Patient/p1')
        const typedClient = yield* FhirR4ResourcesHttpApiClient
        yield* typedClient.Observation.SearchByGet({ urlParams: {} })
      })
    )

    expect(
      server.requests.map((request) => ({
        url: request.url,
        authorization: request.headers['authorization'],
      }))
    ).toEqual([
      { url: 'https://fhir.example/Patient/p1', authorization: 'Bearer tok-123' },
      { url: 'https://fhir.example/Observation', authorization: 'Bearer tok-123' },
    ])
  })
})

describe('buildSmartRouterContext', () => {
  const runtime = smartRuntimeFor(stubConnection(), deadTransport)

  test('carries the runtime it is handed, and its connection', async () => {
    const context = buildSmartRouterContext(runtime)

    await expect(context.runAuthed(Effect.succeed(42))).resolves.toBe(42)
    expect(context.runAuthed).toBe(runtime.runSmart)
    expect(context.runtimeLayer).toBe(runtime.runtimeLayer)
    expect(context.connection).toBe(runtime.connection)
  })

  test('awaitAuthReady resolves — the handshake is already complete', async () => {
    await expect(buildSmartRouterContext(runtime).awaitAuthReady()).resolves.toBeUndefined()
  })

  // The app provides one QueryClient at its root (where the handshake runs) and
  // hands that same instance in here, so the exchange query and every app query
  // share a cache. The context must carry the handed-in client verbatim.
  test('carries the QueryClient it is handed rather than making a second one', () => {
    const queryClient = buildSmartQueryClient()
    expect(buildSmartRouterContext(runtime, queryClient).queryClient).toBe(queryClient)
  })

  test('defaults to a fresh QueryClient when the caller hands none', () => {
    expect(buildSmartRouterContext(runtime).queryClient).not.toBe(
      buildSmartRouterContext(runtime).queryClient
    )
  })
})

describe('buildSmartQueryClient', () => {
  test('reports each failed query to onQueryError with its error and query, once', async () => {
    const onQueryError =
      vi.fn<(queryError: unknown, failedQuery: Query<unknown, unknown, unknown>) => void>()
    const queryClient = buildSmartQueryClient({ onQueryError })
    const readFailure = new Error('401 Unauthorized')

    await expect(
      queryClient.query({
        queryKey: ['failing-read'],
        queryFn: () => Promise.reject(readFailure),
        retry: false,
      })
    ).rejects.toBe(readFailure)

    expect(onQueryError).toHaveBeenCalledTimes(1)
    const [reportedError, failedQuery] = onQueryError.mock.calls[0]
    expect(reportedError).toBe(readFailure)
    expect(failedQuery.queryKey).toStrictEqual(['failing-read'])
  })

  test('reports nothing for a query that succeeds', async () => {
    const onQueryError = vi.fn<() => void>()
    const queryClient = buildSmartQueryClient({ onQueryError })

    await queryClient.query({ queryKey: ['read'], queryFn: () => Promise.resolve('ok') })

    expect(onQueryError).not.toHaveBeenCalled()
  })
})
