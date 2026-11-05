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

import { FetchHttpClient } from '@effect/platform'
import { Layer } from 'effect'

import type { DigestSource, RandomBytesSource } from './pkce.ts'
import {
  RetainedSignInRequestStore,
  SignInCrypto,
  SignInPage,
  type RetainedRequestStorage,
  type SignInServices,
} from './sign-in-services.ts'

/** The slice of `window` a sign-in is built from. A real `Window` satisfies it. */
interface SignInWindow {
  readonly fetch: typeof globalThis.fetch
  readonly crypto: RandomBytesSource & { readonly subtle: DigestSource }
  readonly sessionStorage: RetainedRequestStorage
  readonly location: { readonly href: string; readonly protocol: string }
}

/** The sign-in services of a browser page. */
const BrowserSignIn = {
  /**
   * Every {@link SignInServices} wired to `page`: its `fetch` behind
   * `FetchHttpClient`, its `crypto`, the retained sign-in request at
   * `retainedRequestKey` in its `sessionStorage`, and its `location`'s scheme.
   */
  layer: (page: SignInWindow, retainedRequestKey: string): Layer.Layer<SignInServices> =>
    Layer.mergeAll(
      FetchHttpClient.layer,
      // Called as a method so a real `Window.fetch` keeps its receiver; an
      // unbound reference throws `Illegal invocation` in a browser.
      Layer.succeed(FetchHttpClient.Fetch, (input, init) => page.fetch(input, init)),
      SignInCrypto.layer(page.crypto),
      RetainedSignInRequestStore.sessionStorage(page, retainedRequestKey),
      SignInPage.layer(page.location)
    ),
} as const

export { BrowserSignIn }
export type { SignInWindow }
