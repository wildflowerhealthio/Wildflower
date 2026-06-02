import { createFileRoute, Outlet } from '@tanstack/react-router'
import type { JSX } from 'react'
import { pageLayoutStyles } from 'react-tundraish'

import { authGatedRouteOptions } from '../session/auth-gated-route-options.ts'

/**
 * `/settings` layout — persistent "Settings" header that stays visible
 * across child routes. The slice-contributed `/settings/<slice>/…`
 * subtrees render in the `<Outlet />` below the header.
 *
 * Mounted as a root-level sibling of `_auth` (not under it) so the id
 * (`/settings`) matches what each slice's own generator computes from its
 * top-level `settings/` folder. To preserve auth-gating, this layout
 * re-applies the shared `authGatedRouteOptions` (same `beforeLoad` +
 * `errorComponent` pair the `_auth` layout uses).
 */
function SettingsLayout(): JSX.Element {
  return (
    <div className={pageLayoutStyles['page']}>
      <h1 className="text-heading-4">Settings</h1>
      <Outlet />
    </div>
  )
}

const Route = createFileRoute('/settings')({
  ...authGatedRouteOptions,
  component: SettingsLayout,
})

export { Route, SettingsLayout }
