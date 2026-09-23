/**
 * The one place a browser's impure edges are wired into a
 * {@link SignInEnvironment}.
 *
 * `sign-in.ts` deliberately knows nothing about `window`; every page that runs
 * the flow still has to hand it the same four things (a `fetch`, the crypto
 * sources, `sessionStorage`, and whether the document is secure) plus its own
 * registration. Doing that per app duplicated the wiring — and one part of it
 * is a footgun: `fetch` has to be called as a method or a real `Window` throws
 * `Illegal invocation` on an unbound reference.
 *
 * {@link SignInPage} is declared structurally rather than as `Window`, so a
 * caller passes `window` in the browser and a plain object in a test — no
 * jsdom navigation, and no cast to fake a global.
 */

import type { DigestSource, RandomBytesSource } from './pkce.ts'
import type { PendingStore, SignInEnvironment } from './sign-in.ts'

/** The slice of `window` a sign-in is built from. A real `Window` satisfies it. */
interface SignInPage {
  readonly fetch: typeof globalThis.fetch
  readonly crypto: RandomBytesSource & { readonly subtle: DigestSource }
  readonly sessionStorage: PendingStore
  readonly location: { readonly href: string; readonly protocol: string }
}

/**
 * The app-specific half of the environment: what this page is registered as,
 * where it comes back to, and what it asks for. Every field is the browser-side
 * reading of a seeded `clients` row — a value that drifts from the row fails
 * the flow at `/oauth/authorize` rather than degrading quietly.
 */
interface ClientRegistration {
  /** The `client_id` this page is registered as. */
  readonly clientId: string
  /**
   * The `sessionStorage` key the pending record lives at, namespaced with the
   * app's own name: these pages share an origin, so an unnamespaced key would
   * be one key for all of them and one tab's return leg could consume a record
   * another tab was waiting on.
   */
  readonly pendingKey: string
  /** The space-delimited `scope` parameter to request. */
  readonly scope: string
  /** The redirect URI to send, derived from where the page is served. */
  readonly redirectUri: string
  /**
   * The served root of this page, for a copy of the owner UI — see
   * `SignInEnvironment.clientBaseUrl`.
   */
  readonly clientBaseUrl?: string
}

/** Wire `page`'s impure edges and `registration` into a {@link SignInEnvironment}. */
const browserSignInEnvironment = (
  page: SignInPage,
  registration: ClientRegistration
): SignInEnvironment => ({
  // Called as a method so a real `Window.fetch` keeps its receiver; an unbound
  // reference throws `Illegal invocation` in a browser.
  fetch: (...args) => page.fetch(...args),
  random: page.crypto,
  subtle: page.crypto.subtle,
  store: page.sessionStorage,
  pendingKey: registration.pendingKey,
  clientId: registration.clientId,
  scope: registration.scope,
  redirectUri: registration.redirectUri,
  pageIsSecure: page.location.protocol === 'https:',
  ...(registration.clientBaseUrl === undefined
    ? {}
    : { clientBaseUrl: registration.clientBaseUrl }),
})

export { browserSignInEnvironment }
export type { ClientRegistration, SignInPage }
