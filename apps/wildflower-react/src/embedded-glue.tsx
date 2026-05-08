import { NavigateBinder as ContractsNavigateBinder, useRouteChangeWatcher } from 'contracts-react'
import { Effect } from 'effect'
import type { JSX } from 'react'
import { navRef, pendingNavigations, transport } from './embedded-runtime.ts'

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
 * Embedded-app instantiation of `contracts-react`'s `<NavigateBinder>`,
 * wired against the navRef + queue the runtime exports. Pre-mount nav
 * events queue up; post-mount they flow through `useNavigate()`. Mount
 * once inside the router tree.
 */
function NavigateBinder(): JSX.Element | null {
  return <ContractsNavigateBinder navRef={navRef} queue={pendingNavigations} />
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
