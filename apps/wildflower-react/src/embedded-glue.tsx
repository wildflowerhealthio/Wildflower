import { Effect } from 'effect'
import { useRouteChangeWatcher } from 'interop-react'
import type { JSX } from 'react'
import { useNavigate } from 'react-router'
import { bindNavigate, transport } from './embedded-runtime.ts'

/**
 * Glue components for the embedded SPA. Both are zero-render React
 * artifacts: they exist solely to bridge the host-driven event flow
 * (queued navigation events; route changes the host wants to mirror)
 * into / out of the React tree.
 *
 * Kept in a dedicated file (rather than inline in `main-embedded.tsx`)
 * so the entrypoint stays a flat list of imports + a single `render`
 * call.
 */

/**
 * Populates the embedded runtime's navigate ref on mount and flushes
 * any queued navigation events. Mount this once near the top of the
 * router tree; rendering it has no DOM effect.
 *
 * react-router's `NavigateFunction` is a callable with overloaded
 * signatures (`number` and `To`); the runtime's ref type captures
 * that intersection.
 */
function NavigateBinder(): JSX.Element | null {
  const navigate = useNavigate()
  bindNavigate(navigate as Parameters<typeof bindNavigate>[0])
  return null
}

/**
 * Observes router state via `useRouteChangeWatcher` and forwards each
 * `RouteChanged` message through the live transport. Bridges the
 * hook's sync `(message) => void` contract to the Effect-typed sender
 * via a single `Effect.runSync` per emit.
 */
function RouteChangeWatcher(): JSX.Element | null {
  useRouteChangeWatcher((message) => Effect.runSync(transport.sendMessage(message)))
  return null
}

export { NavigateBinder, RouteChangeWatcher }
