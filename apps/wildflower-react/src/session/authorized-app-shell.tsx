import { Outlet } from '@tanstack/react-router'
import { NeedsAuthMessage } from 'gatekeeper-react'
import type { JSX } from 'react'
import { useAuthTokenSubscribable, useStreamWithDefault } from 'react-kitchen-sink'

/**
 * Outlet wrapper that gates owner-facing routes on a live bearer
 * token. Renders `<NeedsAuthMessage>` (the RFC 8628 device flow) when
 * no token is present; otherwise renders the matched child route via
 * `<Outlet>`.
 *
 * Note: the gatekeeper and collector client layers are the same on
 * both sides of this gate — they read the live token from `BearerToken`
 * (a Subscribable provided by `<AuthTokenProvider>` higher up). Public
 * routes get a `null` token; authenticated routes get the rotated
 * value. No provider re-mount is needed, so this component does pure
 * UI gating.
 */
const AuthorizedAppShell = (): JSX.Element => {
  const { changes: tokenStream } = useAuthTokenSubscribable()
  const token = useStreamWithDefault(tokenStream, null)
  if (token === null || token === '') return <NeedsAuthMessage />
  return <Outlet />
}

export { AuthorizedAppShell }
