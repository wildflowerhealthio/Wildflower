import { createFileRoute, Outlet } from '@tanstack/react-router'
import type { JSX } from 'react'
import { pageLayoutStyles } from 'react-tundraish'

/**
 * Public gatekeeper layout. Wraps the slice's unauthenticated RFC 8628
 * screens in the shared `pageLayoutStyles['page']` shell so each leaf
 * renders content only.
 *
 * See `_auth/gatekeeper.tsx` for why this layout lives at the app level
 * rather than inside the slice.
 */
function GatekeeperOpenLayout(): JSX.Element {
  return (
    <div className={pageLayoutStyles['page']}>
      <Outlet />
    </div>
  )
}

export const Route = createFileRoute('/_open/gatekeeper')({
  component: GatekeeperOpenLayout,
})
