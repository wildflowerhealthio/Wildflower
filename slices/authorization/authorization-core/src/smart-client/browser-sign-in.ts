/**
 * The one place a browser's impure parts are wired into the sign-in services
 * (`sign-in-services.ts`).
 *
 * `sign-in.ts` deliberately knows nothing about `window`; every page that runs
 * the flow still has to provide the same four services from it. Doing that per
 * app duplicated the wiring, and one part of it is a footgun: `fetch` has to be
 * called as a method or a real `Window` throws `Illegal invocation` on an
 * unbound reference.
 *
 * {@link SignInWindow} is declared structurally rather than as `Window`, so a
 * caller passes `window` in the browser and a plain object in a test: no jsdom
 * navigation, and no cast to fake a global.
 */

import { FetchHttpClient, type HttpClient } from '@effect/platform'
import { Layer } from 'effect'

import type { DigestSource, RandomBytesSource } from './pkce.ts'
import {
  RetainedSignInRequestStore,
  SignInCrypto,
  PageSecurity,
  type RetainedRequestStorage,
  type SignInServices,
} from './sign-in-services.ts'

/**
 * The slice of `window` discovery is built from: what reads a server's SMART
 * configuration and judges its endpoints. A real `Window` satisfies it.
 */
interface DiscoveryWindow {
  readonly fetch: typeof globalThis.fetch
  readonly location: { readonly protocol: string }
}

/** The slice of `window` a sign-in is built from. A real `Window` satisfies it. */
interface SignInWindow extends DiscoveryWindow {
  readonly crypto: RandomBytesSource & { readonly subtle: DigestSource }
  readonly sessionStorage: RetainedRequestStorage
  readonly location: { readonly href: string; readonly protocol: string }
}

/**
 * The services discovery runs against, wired to `page`: its `fetch` behind
 * `FetchHttpClient`, and its `location`'s scheme. For a page that reads a
 * server's SMART configuration without signing in to it.
 */
const discoveryLayerFromWindow = (
  page: DiscoveryWindow
): Layer.Layer<HttpClient.HttpClient | PageSecurity> =>
  Layer.mergeAll(
    FetchHttpClient.layer,
    // Called as a method so a real `Window.fetch` keeps its receiver; an
    // unbound reference throws `Illegal invocation` in a browser.
    Layer.succeed(FetchHttpClient.Fetch, (input, init) => page.fetch(input, init)),
    PageSecurity.layerFromWindow(page)
  )

/** The sign-in services of a browser page. */
const BrowserSignIn = {
  discoveryLayerFromWindow,

  /**
   * Every {@link SignInServices} wired to `page`: discovery's
   * ({@link discoveryLayerFromWindow}), its `crypto`, and the retained
   * sign-in request at `retainedRequestKey` in its `sessionStorage`.
   */
  layer: (page: SignInWindow, retainedRequestKey: string): Layer.Layer<SignInServices> =>
    Layer.mergeAll(
      discoveryLayerFromWindow(page),
      SignInCrypto.layerFromWindow(page),
      RetainedSignInRequestStore.sessionStorage(page, retainedRequestKey)
    ),
} as const

export { BrowserSignIn }
export type { DiscoveryWindow, SignInWindow }
