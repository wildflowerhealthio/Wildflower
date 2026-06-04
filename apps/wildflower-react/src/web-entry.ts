import { makeAwaitWebAuthReady, makeWebAuthTokenStore } from 'gatekeeper-react'
import type { RenderAppOptions } from './app-root.tsx'
import { stubTransport } from './bridges/transport-context.ts'

/**
 * Shared `renderApp` wiring for the standalone-web entries (`main-web`
 * and `main-single-web`), which differ only in `history`/`entry` and
 * their `instrument.ts` import — not in auth or transport behavior.
 *
 * Returns the three environment-specific options both web entries
 * share, leaving each entry to spread them into its own `renderApp`
 * call alongside the platform extras. It's a factory, not a wrapper
 * over `renderApp`, so the entries keep their explicit `renderApp` call
 * site (and embedded stays untouched).
 *
 * - `tokenStore`: `localStorage`-backed, with the `?token=…` URL
 *   bootstrap and cross-tab `'storage'` sync. Reads the initial token
 *   synchronously at construction time.
 * - `awaitAuthReady`: ignores `transportReady` (standalone has no host
 *   handshake) and resolves against the store's subscribable — present
 *   token resolves immediately, absent throws the device-login
 *   redirect.
 * - `makeTransport`: pre-resolved stub (no host bridge), so the
 *   `_auth` loader's `await context.transport` is a microtask. The
 *   `writeIssuedToken` setter is ignored — there's no host
 *   `AuthTokenIssued` to receive.
 */
const makeWebEntryOptions = (): Pick<
  RenderAppOptions,
  'tokenStore' | 'awaitAuthReady' | 'makeTransport'
> => {
  const tokenStore = makeWebAuthTokenStore()
  return {
    tokenStore,
    awaitAuthReady: () => makeAwaitWebAuthReady(tokenStore.subscribable),
    makeTransport: () => Promise.resolve(stubTransport),
  }
}

export { makeWebEntryOptions }
