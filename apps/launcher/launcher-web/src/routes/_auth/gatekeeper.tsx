import { createFileRoute, Outlet } from '@tanstack/react-router'
import type { JSX } from 'react'
import { pageLayoutStyles } from 'react-tundraish'

/**
 * Owner-facing gatekeeper layout. Wraps the slice's authed gatekeeper
 * screens (device consent, OAuth consent) in the shared
 * `pageLayoutStyles['page']` shell — mirrors `collector.tsx` — so each
 * leaf renders content only.
 *
 * Lives in the app's routes dir (not the slice) because mounting it
 * inside the slice's `_auth/gatekeeper.tsx` would clash with the sibling
 * `_open/gatekeeper.tsx` layout once both are pulled in via
 * `physical()` from `routes.config.ts` — the router-plugin builds its
 * generated route-variable name from the in-mount path
 * (just `/gatekeeper` for either), and the two would collide. Owning the
 * layout at the app level keeps the `/_auth/` and `/_open/` prefixes in
 * scope so the generator can disambiguate.
 */
function GatekeeperAuthLayout(): JSX.Element {
  return (
    <div className={pageLayoutStyles['page']}>
      <Outlet />
    </div>
  )
}

export const Route = createFileRoute('/_auth/gatekeeper')({
  component: GatekeeperAuthLayout,
})
