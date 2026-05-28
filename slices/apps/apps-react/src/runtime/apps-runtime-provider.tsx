import { AppsBridge } from 'apps-core/bridge'
import { Effect } from 'effect'
import { useMemo, useRef, type JSX, type ReactNode } from 'react'

import {
  AppsRuntimeContext,
  type AppsRuntimeContextValue,
  type TunnelOutcome,
} from './apps-runtime-context.ts'

interface AppsRuntimeProviderProps {
  readonly children: ReactNode
}

const droppedTagWarning = (tag: string): Effect.Effect<void> =>
  Effect.logWarning(`AppsRuntimeProvider: dropping ${tag} — no pending tunnel request`)

/**
 * Owns the active tunnel-request resolver ref the `useRequestTunnel`
 * hook installs into, and exports a memoised `receiverLayer` that
 * forwards every Host→Web AppsBridge tag into whatever resolver is
 * currently installed. The app's transport provider plumbs the receiver
 * layer into `BridgeTransport.make`.
 *
 * Mount *above* the app's `<TransportProvider>` so the transport can
 * read the receiver layer when it builds.
 *
 * No event bus and no module-level singletons: when nothing is
 * installed (idle SPA) the layer log-and-drops; when a screen calls
 * `useRequestTunnel()` it installs a resolver, fires the
 * `RequestTunnel` message, awaits the next `TunnelStarted` /
 * `TunnelFailed` response, and clears the resolver.
 */
const AppsRuntimeProvider = ({ children }: AppsRuntimeProviderProps): JSX.Element => {
  const pendingResolverRef = useRef<((outcome: TunnelOutcome) => void) | null>(null)

  const value = useMemo<AppsRuntimeContextValue>(
    () => ({
      setPendingTunnelResolver: (resolver) => {
        pendingResolverRef.current = resolver
      },
      receiverLayer: AppsBridge.Web.ReceiverLayer({
        TunnelStarted: ({ origin }) => {
          const resolver = pendingResolverRef.current
          if (resolver === null) return droppedTagWarning('TunnelStarted')
          pendingResolverRef.current = null
          return Effect.sync(() => {
            resolver({ origin })
          })
        },
        TunnelFailed: ({ reason }) => {
          const resolver = pendingResolverRef.current
          if (resolver === null) return droppedTagWarning('TunnelFailed')
          pendingResolverRef.current = null
          return Effect.sync(() => {
            resolver({ error: reason })
          })
        },
      }),
    }),
    []
  )

  return <AppsRuntimeContext.Provider value={value}>{children}</AppsRuntimeContext.Provider>
}

export { AppsRuntimeProvider }
export type { AppsRuntimeProviderProps }
