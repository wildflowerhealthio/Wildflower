import { HttpClient } from '@effect/platform'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Effect, Either, Option, Ref } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { BrowserSignIn, type SignInWindow } from './browser-sign-in.ts'
import {
  PageSecurity,
  RetainedSignInRequestStore,
  SignInCrypto,
  signInHttpClient,
} from './sign-in-services.ts'
import { memoryStore, throwingStore } from './sign-in.test-helpers.ts'

const RETAINED_REQUEST_KEY = 'launcher-web.pending-authorization'

/** A {@link SignInWindow} whose impure parts are stubs a test can watch. */
const pageAt = (
  href: string,
  options: {
    readonly protocol?: string
    readonly onFetch?: (request: Request) => void
    readonly sessionStorage?: SignInWindow['sessionStorage']
  } = {}
): SignInWindow => ({
  fetch: function (this: unknown, input, init) {
    // Records the receiver the flow calls with: a real `Window.fetch` throws
    // `Illegal invocation` when it is called without one.
    if (this === undefined) throw new TypeError('Illegal invocation')
    options.onFetch?.(new Request(input, init))
    return Promise.resolve(new Response('{}'))
  },
  crypto: {
    getRandomValues: <T extends ArrayBufferView>(array: T): T => array,
    subtle: { digest: () => Promise.resolve(new ArrayBuffer(32)) },
  },
  sessionStorage: options.sessionStorage ?? memoryStore(),
  location: { href, protocol: options.protocol ?? 'https:' },
})

/** Run `effect` on the sign-in services of `page`. */
const runOn = <A, E>(
  page: SignInWindow,
  effect: Effect.Effect<
    A,
    E,
    HttpClient.HttpClient | SignInCrypto | RetainedSignInRequestStore | PageSecurity
  >
): Promise<Either.Either<A, E>> =>
  Effect.runPromise(
    Effect.either(Effect.provide(effect, BrowserSignIn.layerFromWindow(page, RETAINED_REQUEST_KEY)))
  )

describe('BrowserSignIn.layerFromWindow', () => {
  it('calls the page’s fetch as a method, so a real Window keeps its receiver', async () => {
    // Arrange — the footgun this layer exists to hold: `fetch: page.fetch`
    // would hand the flow an unbound reference.
    const sent: string[] = []
    const page = pageAt('https://wildflowerhealth.io/', {
      onFetch: (request) => sent.push(request.url),
    })

    // Act
    const result = await runOn(
      page,
      Effect.flatMap(HttpClient.HttpClient, (client) =>
        client.get('https://example.test/.well-known/smart-configuration')
      )
    )

    // Assert
    expect(Either.isRight(result)).toBe(true)
    expect(sent).toEqual(['https://example.test/.well-known/smart-configuration'])
  })

  it('sends no trace headers through the sign-in’s HttpClient', async () => {
    // A `traceparent` would turn a cross-origin discovery or token request into
    // a CORS preflight the server may refuse.
    // Arrange
    const headers: string[] = []
    const page = pageAt('https://wildflowerhealth.io/', {
      onFetch: (request) => headers.push(...request.headers.keys()),
    })

    // Act
    await runOn(
      page,
      Effect.flatMap(signInHttpClient, (client) =>
        client.get('https://example.test/.well-known/smart-configuration', { acceptJson: true })
      )
    )

    // Assert
    expect(headers).toEqual(['accept'])
  })

  it('reports the page as secure only on https', async () => {
    // This decides whether a plaintext target is reachable at all, so it has to
    // follow the document and not a build flag.
    const secure = await runOn(pageAt('https://x.test/'), PageSecurity)
    const plain = await runOn(pageAt('http://127.0.0.1:5173/', { protocol: 'http:' }), PageSecurity)

    expect(secure).toEqual(Either.right({ pageIsSecure: true }))
    expect(plain).toEqual(Either.right({ pageIsSecure: false }))
  })

  it('reads random bytes and digests from the page’s crypto', async () => {
    // Arrange
    const page = pageAt('https://x.test/')

    // Act
    const crypto = await runOn(page, SignInCrypto)

    // Assert
    expect(Either.map(crypto, ({ randomBytes, digest }) => ({ randomBytes, digest }))).toEqual(
      Either.right({ randomBytes: page.crypto, digest: page.crypto.subtle })
    )
  })
})

describe('BrowserSignIn.discoveryLayerFromWindow', () => {
  it('wires discovery to a page that has only fetch and a location', async () => {
    // Arrange — no crypto and no storage: discovery needs neither.
    const sent: string[] = []
    const page = pageAt('http://127.0.0.1:5173/', {
      protocol: 'http:',
      onFetch: (request) => sent.push(request.url),
    })
    const discoveryPage = { fetch: page.fetch, location: page.location }

    // Act
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        yield* client.get('https://example.test/.well-known/smart-configuration')
        return yield* PageSecurity
      }).pipe(Effect.provide(BrowserSignIn.discoveryLayerFromWindow(discoveryPage)), Effect.either)
    )

    // Assert
    expect(result).toEqual(Either.right({ pageIsSecure: false }))
    expect(sent).toEqual(['https://example.test/.well-known/smart-configuration'])
  })
})

describe('RetainedSignInRequestStore.sessionStorageBackedLayer', () => {
  it('property: keeps, reads and forgets the request at its key alone', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1 }), async (request) => {
        // Arrange
        const sessionStorage = memoryStore()
        sessionStorage.setItem('another-flow', 'kept')
        const page = pageAt('https://x.test/', { sessionStorage })

        // Act
        const read = await runOn(
          page,
          Effect.gen(function* () {
            const store = yield* RetainedSignInRequestStore
            yield* store.retain(request)
            const kept = yield* store.read
            yield* store.forget
            return { kept, afterForget: yield* store.read }
          })
        )

        // Assert
        expect(read).toEqual(
          Either.right({ kept: Option.some(request), afterForget: Option.none() })
        )
        expect(sessionStorage.getItem('another-flow')).toBe('kept')
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('fails every call on a blocked storage with RetainedRequestUnusable', async () => {
    // Arrange
    const page = pageAt('https://x.test/', { sessionStorage: throwingStore() })
    const calls = [
      Effect.flatMap(RetainedSignInRequestStore, (store) => store.retain('a-request')),
      Effect.flatMap(RetainedSignInRequestStore, (store) => store.read),
      Effect.flatMap(RetainedSignInRequestStore, (store) => store.forget),
    ]

    // Act
    const results = await Promise.all(calls.map((call) => runOn(page, call)))

    // Assert
    expect(results.map((result) => Either.isLeft(result) && result.left._tag)).toEqual([
      'RetainedRequestUnusable',
      'RetainedRequestUnusable',
      'RetainedRequestUnusable',
    ])
  })
})

describe('RetainedSignInRequestStore.memoryBackedLayer', () => {
  it('keeps, reads and forgets the request in the Ref it was given', async () => {
    // Act
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const held = yield* Ref.make(Option.none<string>())
        const store = yield* Effect.provide(
          RetainedSignInRequestStore,
          RetainedSignInRequestStore.memoryBackedLayer(held)
        )
        yield* store.retain('a-request')
        const kept = yield* Ref.get(held)
        yield* store.forget
        return { kept, afterForget: yield* store.read }
      })
    )

    // Assert
    expect(result).toEqual({ kept: Option.some('a-request'), afterForget: Option.none() })
  })
})
