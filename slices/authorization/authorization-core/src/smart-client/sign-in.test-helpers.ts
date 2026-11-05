/**
 * The services a sign-in runs against, for the tests of `sign-in.ts` and
 * `smart-discovery.ts`: a stub transport behind the context's `HttpClient`,
 * real Web Crypto, a retained-request store over a `sessionStorage`-shaped map,
 * and a page served over https unless a test says otherwise.
 *
 * @packageDocumentation
 */
import { FetchHttpClient, type HttpClient } from '@effect/platform'
import { Effect, type Either, Layer } from 'effect'

import {
  PageSecurity,
  RetainedSignInRequestStore,
  SignInCrypto,
  type RetainedRequestStorage,
  type SignInServices,
} from './sign-in-services.ts'

/** How the stub server answers one request: what a `fetch` would resolve to. */
type StubAnswer = (request: Request) => Promise<Response>

/**
 * An `HttpClient` whose every request is answered by `answer`, as the browser's
 * `fetch` would carry it: the request `answer` sees is the one that would go on
 * the wire, headers and body included.
 */
const stubTransport = (answer: StubAnswer): Layer.Layer<HttpClient.HttpClient> =>
  Layer.mergeAll(
    FetchHttpClient.layer,
    Layer.succeed(FetchHttpClient.Fetch, (input, init) => answer(new Request(input, init)))
  )

/** A stub answer that fails the test if the flow sends anything. */
const refuseEveryRequest: StubAnswer = (request) => {
  throw new Error(`no request was expected, got one to ${request.url}`)
}

/** A 200 JSON response carrying `body`. */
const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

/** A `sessionStorage`-shaped store backed by a map, plus a peek at everything in it. */
const memoryStore = (): RetainedRequestStorage & { contents(): string } => {
  const entries = new Map<string, string>()
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value)
    },
    removeItem: (key) => {
      entries.delete(key)
    },
    contents: () => JSON.stringify([...entries]),
  }
}

/** Throw as a blocked storage does on every call. */
const blocked = (): never => {
  throw new DOMException('The operation is insecure.', 'SecurityError')
}

/** A `sessionStorage` that throws on every call, as a blocked one does. */
const throwingStore = (): RetainedRequestStorage => ({
  getItem: blocked,
  setItem: blocked,
  removeItem: blocked,
})

/**
 * The services a sign-in runs against in a test: `answer` behind the
 * `HttpClient`, real Web Crypto, the retained request at `retainedRequestKey`
 * in `store`, and a page that is secure unless `pageIsSecure` says not.
 */
const testSignInLayer = (parts: {
  readonly store: RetainedRequestStorage
  readonly answer: StubAnswer
  readonly retainedRequestKey: string
  readonly pageIsSecure?: boolean
}): Layer.Layer<SignInServices> =>
  Layer.mergeAll(
    stubTransport(parts.answer),
    SignInCrypto.layerFromWindow(globalThis),
    RetainedSignInRequestStore.sessionStorageBackedLayer(
      { sessionStorage: parts.store },
      parts.retainedRequestKey
    ),
    Layer.succeed(PageSecurity, { pageIsSecure: parts.pageIsSecure ?? true })
  )

/**
 * Run a sign-in Effect against `services` to its `Either`, so the tagged error
 * is assertable instead of being thrown out of the test.
 */
const runToEither = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  services: Layer.Layer<R>
): Promise<Either.Either<A, E>> =>
  Effect.runPromise(Effect.either(Effect.provide(effect, services)))

export {
  jsonResponse,
  memoryStore,
  refuseEveryRequest,
  runToEither,
  stubTransport,
  testSignInLayer,
  throwingStore,
  type StubAnswer,
}
