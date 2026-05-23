import { Effect } from 'effect'
import { NeedsAuthMessage, waitForHostTokenRef } from 'gatekeeper-react'
import { useMemo, useEffect, type JSX } from 'react'
import { useAuthTokenSubscribable, useStreamWithDefault } from 'react-kitchen-sink'
import { Outlet } from 'react-router'
import { PageLoading } from 'react-tundraish'

/**
 * Outlet wrapper that gates owner-facing routes on a live bearer
 * token. Three branches:
 *
 * - Token present → render the matched child route via `<Outlet>`.
 * - No token, but the host signaled `WaitForToken` over the gatekeeper
 *   bridge → render a neutral loader; hold until `AuthTokenIssued`
 *   arrives. The Expo host always signals `WaitForToken` at boot via
 *   URL params, dispatched by `TransportProvider` before this tree
 *   mounts.
 * - No token, no `WaitForToken` (standalone web) → render
 *   `<NeedsAuthMessage>` to start the RFC 8628 device flow.
 *
 * The gatekeeper and collector client layers are the same on both
 * sides of this gate — they read the live token from `BearerToken`
 * (a Subscribable provided by `<AuthTokenProvider>` higher up). No
 * provider re-mount is needed, so this component does pure UI gating.
 */
const AuthorizedAppShell = (): JSX.Element => {
  const { changes: tokenStream, get: currentTokenEffect } = useAuthTokenSubscribable()
  const initialToken = useMemo(() => Effect.runSync(currentTokenEffect), [currentTokenEffect])
  const token = useStreamWithDefault(tokenStream, initialToken)
  const initialWaitForHost = useMemo(() => Effect.runSync(waitForHostTokenRef.get), [])
  const waitForHostToken = useStreamWithDefault(waitForHostTokenRef.changes, initialWaitForHost)
  useEffect(() => {
    console.debug(
      '[AuthorizedAppShell] token',
      token?.slice(0, 5),
      'waitForHostToken',
      waitForHostToken
    )
  }, [token, waitForHostToken])
  if (token !== null && token !== '') return <Outlet />
  if (waitForHostToken) return <PageLoading message="Loading app shell" />
  return <NeedsAuthMessage />
}

export { AuthorizedAppShell }
