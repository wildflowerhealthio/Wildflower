import { HttpClient, HttpClientRequest, HttpClientResponse } from '@effect/platform'
import { Effect, Layer } from 'effect'
import fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import {
  buildSmartQueryClient,
  buildSmartRouterContext,
  smartHttpClientLayer,
  type SmartSession,
} from './self-hosted-runtime.ts'

/**
 * Drive one request through a layer and hand back what actually went on the
 * wire. The inner `HttpClient` is a stub, so nothing leaves the test.
 */
const sendThrough = (
  session: SmartSession,
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
    }).pipe(Effect.provide(smartHttpClientLayer(session, stub)))
  )
}

describe('smartHttpClientLayer', () => {
  const session = { serverUrl: 'http://127.0.0.1:8080/fhir-r4', accessToken: 'tok-123' }

  test('addresses a relative client path at the FHIR server and attaches the token', async () => {
    const sent = await sendThrough(session, HttpClientRequest.get('/DocumentReference'))
    expect(sent.url).toBe('http://127.0.0.1:8080/fhir-r4/DocumentReference')
    expect(sent.authorization).toBe('Bearer tok-123')
  })

  // The client no longer bakes in `/fhir-r4`, so the base is now whatever server
  // the handshake named — a sandbox base with its own subpath, an EHR's `iss`,
  // anything. It is prepended verbatim (trailing slashes trimmed) rather than
  // parsed, so any of these addresses correctly.
  test('prepends an arbitrary server base verbatim', async () => {
    const sent = await sendThrough(
      { serverUrl: 'https://launch.smarthealthit.org/v/r4/fhir', accessToken: undefined },
      HttpClientRequest.get('/Patient')
    )
    expect(sent.url).toBe('https://launch.smarthealthit.org/v/r4/fhir/Patient')
  })

  test('property: any server base is prepended verbatim to a relative path', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.webUrl({ withQueryParameters: false, withFragments: false }),
        fc.nat({ max: 3 }),
        async (origin: string, extraSlashes: number) => {
          const base = origin.replace(/\/+$/u, '')
          // A trailing-slash-carrying `serverUrl` must address identically: only
          // trailing slashes are trimmed, nothing else about the base is touched.
          const serverUrl = `${base}${'/'.repeat(extraSlashes)}`
          const sent = await sendThrough(
            { serverUrl, accessToken: undefined },
            HttpClientRequest.get('/Patient')
          )
          expect(sent.url).toBe(`${base}/Patient`)
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

describe('buildSmartRouterContext', () => {
  test('runAuthed runs an effect against the built runtime', async () => {
    const context = buildSmartRouterContext(
      { serverUrl: 'http://127.0.0.1:8080/fhir-r4', accessToken: 'tok-123' },
      deadTransport
    )
    await expect(context.runAuthed(Effect.succeed(42))).resolves.toBe(42)
  })

  test('awaitAuthReady resolves — the handshake is already complete', async () => {
    const context = buildSmartRouterContext(
      { serverUrl: 'http://127.0.0.1:8080/fhir-r4', accessToken: 'tok-123' },
      deadTransport
    )
    await expect(context.awaitAuthReady()).resolves.toBeUndefined()
  })

  // The app provides one QueryClient at its root (where the handshake runs) and
  // hands that same instance in here, so the exchange query and every app query
  // share a cache. The context must carry the handed-in client verbatim.
  test('carries the QueryClient it is handed rather than making a second one', () => {
    const queryClient = buildSmartQueryClient()
    const context = buildSmartRouterContext(
      { serverUrl: 'http://127.0.0.1:8080/fhir-r4', accessToken: 'tok-123' },
      deadTransport,
      queryClient
    )
    expect(context.queryClient).toBe(queryClient)
  })

  test('defaults to a fresh QueryClient when the caller hands none', () => {
    const session = { serverUrl: 'http://127.0.0.1:8080/fhir-r4', accessToken: 'tok-123' }
    const first = buildSmartRouterContext(session, deadTransport)
    const second = buildSmartRouterContext(session, deadTransport)
    expect(first.queryClient).not.toBe(second.queryClient)
  })
})
