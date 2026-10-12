import { createRootRouteWithContext } from '@tanstack/react-router'

import { HostNotFound } from '../host-not-found.tsx'
import { HostShell } from '../host-shell.tsx'
import type { RouterContext } from '../router-context.ts'

/**
 * The host's root: the Servers | Recorder bar over every route, the not-found
 * page included. Its loader settles the Recorder's transport, once, before
 * the bar first renders.
 */
export const Route = createRootRouteWithContext<RouterContext>()({
  loader: ({ context }) => context.recorderConnection,
  staleTime: Infinity,
  component: HostShell,
  notFoundComponent: HostNotFound,
})
