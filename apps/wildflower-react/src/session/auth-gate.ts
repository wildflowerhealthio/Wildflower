import { redirect } from '@tanstack/react-router'
import { DEVICE_LOGIN_PATH, NeedsSignIn } from 'gatekeeper-react'

import type { RouterContext } from '../router-context.ts'

/**
 * `beforeLoad` auth gate for the owner-facing layouts (`_auth`,
 * `/settings`). Calls the injected, environment-specific
 * `context.awaitAuthReady()` and branches on its tagged rejection:
 *
 *   - resolve → proceed (an authed loader below is guaranteed a token).
 *   - `NeedsSignIn` (standalone web, no token) → `throw redirect` into
 *     the public device-login flow.
 *   - `TokenTimeout` (embedded, host never delivered the token in 5s) →
 *     rethrow so the layout's `errorComponent` renders the web-side
 *     `TokenTimeoutRetry` screen. No host signal on timeout — the user
 *     re-attempts the wait from the browser.
 *
 * Any other rejection is unexpected; rethrow it so it surfaces rather
 * than being silently swallowed into a proceed.
 */
const authBeforeLoad = async ({ context }: { readonly context: RouterContext }): Promise<void> => {
  try {
    await context.awaitAuthReady()
  } catch (error) {
    if (error instanceof NeedsSignIn) {
      throw redirect({ to: DEVICE_LOGIN_PATH })
    }
    throw error
  }
}

export { authBeforeLoad }
