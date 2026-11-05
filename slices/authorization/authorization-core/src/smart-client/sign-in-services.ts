/**
 * The page's impure parts a sign-in runs against, as Effect services: the
 * random bytes and digest PKCE needs ({@link SignInCrypto}), the storage that
 * carries the retained sign-in request across the redirect
 * ({@link RetainedSignInRequestStore}), and whether the page is secure
 * ({@link SignInPage}). The fourth, the `HttpClient` that discovery and the
 * token request go through, is `@effect/platform`'s own.
 *
 * `browser-sign-in.ts` wires all four to a browser page; a test provides the
 * one it cares about in its place.
 */

import { HttpClient } from '@effect/platform'
import {
  getStorageItem,
  removeStorageItem,
  setStorageItem,
  StorageBlocked,
  takeStorageItem,
} from '@wildflowerhealthio/kitchen-sink'
import { Context, Data, Effect, Layer, Match, Option, Ref } from 'effect'

import type { DigestSource, RandomBytesSource } from './pkce.ts'

/**
 * Raised when the browser will not carry the retained sign-in request across
 * the redirect: Safari's private mode throws on `setItem`, and a blocked
 * storage throws on every read.
 */
class RetainedRequestUnusable extends Data.TaggedError('RetainedRequestUnusable')<{
  readonly reason: string
}> {}

/** The Web Crypto sources a sign-in mints its PKCE pair and `state` from. */
class SignInCrypto extends Context.Tag('authorization-core/SignInCrypto')<
  SignInCrypto,
  {
    /** Where the code verifier's and the `state`'s random bytes come from. */
    readonly random: RandomBytesSource
    /** What hashes the code verifier into its S256 challenge. */
    readonly subtle: DigestSource
  }
>() {
  /**
   * The {@link SignInCrypto} of a page's `crypto`. Its methods are called on
   * the objects they belong to, so a real `Crypto` keeps its receiver.
   */
  static readonly layer = (
    crypto: RandomBytesSource & { readonly subtle: DigestSource }
  ): Layer.Layer<SignInCrypto> =>
    Layer.sync(SignInCrypto, () => ({ random: crypto, subtle: crypto.subtle }))
}

/** The `sessionStorage`-shaped slice the retained sign-in request is kept in. */
interface RetainedRequestStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/**
 * Why a sign-in whose request `blocked` storage would not keep or give back
 * cannot be completed: the one wording for every sign-in request a page
 * retains across the redirect, this module's and an app's own.
 */
const retainedRequestUnusableFrom = (blocked: StorageBlocked): RetainedRequestUnusable =>
  new RetainedRequestUnusable({
    reason: Match.value(blocked.operation).pipe(
      Match.when(
        'write',
        () =>
          'This browser would not let the page remember the sign-in request ' +
          '(session storage is blocked), so it cannot be completed.'
      ),
      Match.whenOr(
        'read',
        'remove',
        () =>
          'This browser would not let the page use the sign-in request it kept ' +
          '(session storage is blocked), so it cannot be completed.'
      ),
      Match.exhaustive
    ),
  })

/**
 * A store for one retained request, as the string its owner serialises it to:
 * the shape of {@link RetainedSignInRequestStore}, and of any other request a
 * page retains across a redirect under its own service.
 */
interface RetainedRequestStoreShape {
  /** Keep `request`, replacing any request kept before it. */
  readonly retain: (request: string) => Effect.Effect<void, RetainedRequestUnusable>
  /**
   * The kept request, `None` when there is none. It is left in place, for a
   * page that needs to know what a flow is waiting on before the flow takes it.
   */
  readonly read: Effect.Effect<Option.Option<string>, RetainedRequestUnusable>
  /**
   * The kept request, dropped once read: `None` when there is none. Only a
   * refused read fails; a request that was read is returned even if the
   * store then refuses to drop it.
   */
  readonly take: Effect.Effect<Option.Option<string>, RetainedRequestUnusable>
  /** Drop the kept request, if there is one. */
  readonly forget: Effect.Effect<void, RetainedRequestUnusable>
}

/**
 * The store at `key` in `page`'s `sessionStorage`, which is per origin and
 * per tab. Each Wildflower app is served from its own origin, so the key
 * only has to tell apart the flows one app runs in a tab: one key per flow.
 *
 * `page.sessionStorage` is read on every call, inside the Effect, since a
 * browser that blocks storage can throw on the property read itself. Every
 * throw fails with {@link RetainedRequestUnusable}.
 */
const sessionStorageBackedRetainedRequestStore = (
  page: { readonly sessionStorage: RetainedRequestStorage },
  key: string
): RetainedRequestStoreShape => {
  const storageFor = (
    operation: StorageBlocked['operation']
  ): Effect.Effect<RetainedRequestStorage, StorageBlocked> =>
    Effect.try({
      try: () => page.sessionStorage,
      catch: () => new StorageBlocked({ operation, key }),
    })
  return {
    retain: (request) =>
      storageFor('write').pipe(
        Effect.flatMap((storage) => setStorageItem(storage, key, request)),
        Effect.mapError(retainedRequestUnusableFrom)
      ),
    read: storageFor('read').pipe(
      Effect.flatMap((storage) => getStorageItem(storage, key)),
      Effect.mapError(retainedRequestUnusableFrom)
    ),
    take: storageFor('read').pipe(
      Effect.flatMap((storage) => takeStorageItem(storage, key)),
      Effect.mapError(retainedRequestUnusableFrom)
    ),
    forget: storageFor('remove').pipe(
      Effect.flatMap((storage) => removeStorageItem(storage, key)),
      Effect.mapError(retainedRequestUnusableFrom)
    ),
  }
}

/** A store in `held`, which never refuses: for a test to read and seed. */
const memoryBackedRetainedRequestStore = (
  held: Ref.Ref<Option.Option<string>>
): RetainedRequestStoreShape => ({
  retain: (request) => Ref.set(held, Option.some(request)),
  read: Ref.get(held),
  take: Ref.getAndSet(held, Option.none()),
  forget: Ref.set(held, Option.none()),
})

/**
 * Where the one sign-in request a flow has in progress is kept, from the
 * sign-in that starts it to the return leg that takes it, as the string
 * `sign-in.ts` serialises it to.
 */
class RetainedSignInRequestStore extends Context.Tag(
  'authorization-core/RetainedSignInRequestStore'
)<RetainedSignInRequestStore, RetainedRequestStoreShape>() {
  /** The store at `key` in `page`'s `sessionStorage` ({@link sessionStorageBackedRetainedRequestStore}). */
  static readonly sessionStorage = (
    page: { readonly sessionStorage: RetainedRequestStorage },
    key: string
  ): Layer.Layer<RetainedSignInRequestStore> =>
    Layer.succeed(RetainedSignInRequestStore, sessionStorageBackedRetainedRequestStore(page, key))

  /** A store in `held`, which never refuses: for a test to read and seed. */
  static readonly inMemory = (
    held: Ref.Ref<Option.Option<string>>
  ): Layer.Layer<RetainedSignInRequestStore> =>
    Layer.succeed(RetainedSignInRequestStore, memoryBackedRetainedRequestStore(held))
}

/**
 * The page a sign-in runs on. A fact about the page, not the app: an `https:`
 * page refuses discovered endpoints that are plain http off loopback.
 */
class SignInPage extends Context.Tag('authorization-core/SignInPage')<
  SignInPage,
  {
    /** Whether the page is served over `https:`. */
    readonly isSecure: boolean
  }
>() {
  /** The {@link SignInPage} served at `location`. */
  static readonly layer = (location: { readonly protocol: string }): Layer.Layer<SignInPage> =>
    Layer.sync(SignInPage, () => ({ isSecure: location.protocol === 'https:' }))
}

/**
 * The context's `HttpClient`, sending no trace headers. Discovery and the
 * token request go cross-origin, where a `traceparent` header would turn each
 * into a CORS preflight the server may refuse; without one, both stay simple
 * requests.
 */
const signInHttpClient: Effect.Effect<HttpClient.HttpClient, never, HttpClient.HttpClient> =
  Effect.map(HttpClient.HttpClient, HttpClient.withTracerPropagation(false))

/** Every service a whole sign-in, both halves, runs against. */
type SignInServices = HttpClient.HttpClient | SignInCrypto | RetainedSignInRequestStore | SignInPage

export {
  memoryBackedRetainedRequestStore,
  RetainedRequestUnusable,
  retainedRequestUnusableFrom,
  RetainedSignInRequestStore,
  SignInCrypto,
  SignInPage,
  signInHttpClient,
  sessionStorageBackedRetainedRequestStore,
}
export type { RetainedRequestStorage, RetainedRequestStoreShape, SignInServices }
