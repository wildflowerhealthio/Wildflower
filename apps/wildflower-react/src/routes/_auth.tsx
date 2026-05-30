import { createFileRoute, Outlet } from '@tanstack/react-router'
import type { JSX } from 'react'

import { UIReadyEmitter } from '../bridges/ui-ready-emitter.tsx'
import { authBeforeLoad } from '../session/auth-gate.ts'
import { TokenTimeoutRetry } from '../session/token-timeout-retry.tsx'

/**
 * Pathless `_auth` layout. Gates owner-facing routes on a live bearer
 * token via a `beforeLoad` that `await`s the injected
 * `context.awaitAuthReady()` — standalone web with no token redirects
 * into the device-login flow, embedded waits the host handshake (and on
 * timeout renders the `TokenTimeoutRetry` screen). Once the gate passes
 * the matched child route renders through `<Outlet>`, with its authed
 * loaders guaranteed a token.
 *
 * Mounts {@link UIReadyEmitter} (post-gate, token guaranteed) to warm
 * the startup prefetches and post the embedded `UIReady` handshake.
 *
 * Each slice's `_auth/` directory is mounted as a child of this layout
 * by the virtual-route config, so the slice-local URLs (e.g.
 * `/collector`) gain no extra path segment.
 */
function AuthLayout(): JSX.Element {
  return (
    <>
      <UIReadyEmitter />
      <Outlet />
    </>
  )
}

export const Route = createFileRoute('/_auth')({
  beforeLoad: authBeforeLoad,
  component: AuthLayout,
  errorComponent: TokenTimeoutRetry,
})
