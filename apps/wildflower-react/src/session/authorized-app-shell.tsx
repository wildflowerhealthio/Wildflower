import { NeedsAuthMessage } from 'gatekeeper-react'
import type { JSX } from 'react'
import { useAuthTokenSubscribable, useStreamWithDefault } from 'react-kitchen-sink'
import { Outlet } from 'react-router'

/**
 * Outlet wrapper that gates owner-facing routes on a live bearer
 * token. Renders `<NeedsAuthMessage>` (the RFC 8628 device flow) when
 * no token is present; otherwise renders the matched child `<Route>`
 * via `<Outlet>`.
 *
 * Note: the gatekeeper client layer is the same on both sides of this
 * gate — it reads the live token from `BearerToken` (a Subscribable
 * provided by `<AuthTokenProvider>` higher up). Public routes get a
 * `null` token; authenticated routes get the rotated value. No
 * provider re-mount is needed, so this component does pure UI gating.
 */
const AuthorizedAppShell = (): JSX.Element => {
  const { changes: tokenStream } = useAuthTokenSubscribable()
  const token = useStreamWithDefault(tokenStream, null)
  if (token === null || token === '') return <NeedsAuthMessage />
  return <Outlet />
}

export { AuthorizedAppShell }
