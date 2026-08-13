import { HttpClient, HttpClientRequest, HttpClientResponse } from '@effect/platform'
import { Effect, Either, Layer } from 'effect'
import fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import {
  apiBaseUrlFromIss,
  buildSmartRouterContext,
  smartHttpClientLayer,
  UnexpectedFhirBase,
  type SmartSession,
} from './self-hosted-runtime.ts'

/** Unwrap a `Right`, or fail the test naming the `Left` it got instead. */
const rightOf = <A>(either: Either.Either<A, UnexpectedFhirBase>): A => {
  if (Either.isLeft(either)) throw new Error(`expected a Right, got Left: ${either.left.message}`)
  return either.right
}

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
    }).pipe(Effect.provide(rightOf(smartHttpClientLayer(session, stub))))
  )
}

describe('apiBaseUrlFromIss', () => {
  test('strips the API prefix the typed client re-adds', () => {
    expect(rightOf(apiBaseUrlFromIss('http://127.0.0.1:8080/fhir-r4'))).toBe(
      'http://127.0.0.1:8080'
    )
  })

  test('tolerates a trailing slash on the iss', () => {
    expect(rightOf(apiBaseUrlFromIss('https://device.example/fhir-r4/'))).toBe(
      'https://device.example'
    )
  })

  test('keeps a subpath deployment intact', () => {
    expect(rightOf(apiBaseUrlFromIss('https://example.test/wildflower/fhir-r4'))).toBe(
      'https://example.test/wildflower'
    )
  })

  // The whole point of failing rather than guessing: a guessed prefix would send
  // every request somewhere plausible and wrong, surfacing as an unexplained 404.
  test('returns a Left rather than guessing when the iss names another FHIR base', () => {
    const result = apiBaseUrlFromIss('https://ehr.example/r4')
    if (Either.isRight(result)) throw new Error('expected a Left')
    expect(result.left).toBeInstanceOf(UnexpectedFhirBase)
  })

  test('round-trips: prefixing the result with the API prefix reproduces the iss', () => {
    fc.assert(
      fc.property(
        fc.webUrl({ withQueryParameters: false, withFragments: false }),
        (origin: string) => {
          const base = origin.replace(/\/+$/u, '')
          expect(rightOf(apiBaseUrlFromIss(`${base}/fhir-r4`))).toBe(base)
        }
      )
    )
  })
})

describe('smartHttpClientLayer', () => {
  const session = { serverUrl: 'http://127.0.0.1:8080/fhir-r4', accessToken: 'tok-123' }

  test('addresses a relative client path at the FHIR server and attaches the token', async () => {
    const sent = await sendThrough(session, HttpClientRequest.get('/fhir-r4/DocumentReference'))
    expect(sent.url).toBe('http://127.0.0.1:8080/fhir-r4/DocumentReference')
    expect(sent.authorization).toBe('Bearer tok-123')
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
      HttpClientRequest.get('/fhir-r4/DocumentReference')
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
    const context = rightOf(
      buildSmartRouterContext(
        { serverUrl: 'http://127.0.0.1:8080/fhir-r4', accessToken: 'tok-123' },
        deadTransport
      )
    )
    await expect(context.runAuthed(Effect.succeed(42))).resolves.toBe(42)
  })

  test('awaitAuthReady resolves — the handshake is already complete', async () => {
    const context = rightOf(
      buildSmartRouterContext(
        { serverUrl: 'http://127.0.0.1:8080/fhir-r4', accessToken: 'tok-123' },
        deadTransport
      )
    )
    await expect(context.awaitAuthReady()).resolves.toBeUndefined()
  })

  test('an unaddressable iss is a Left at build time, not a failure at first read', () => {
    const result = buildSmartRouterContext(
      { serverUrl: 'https://ehr.example/r4', accessToken: 'tok' },
      deadTransport
    )
    if (Either.isRight(result)) throw new Error('expected a Left')
    expect(result.left).toBeInstanceOf(UnexpectedFhirBase)
  })
})
