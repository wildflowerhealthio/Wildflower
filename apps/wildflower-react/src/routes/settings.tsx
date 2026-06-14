import { createFileRoute, Outlet } from '@tanstack/react-router'
import type { JSX } from 'react'
import { pageLayoutStyles } from 'react-tundraish'

import { authGatedRouteOptions } from '../session/auth-gated-route-options.ts'
import { AppTabShell } from '../session/tab-bar.tsx'

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
    <AppTabShell>
      <div className={pageLayoutStyles['page']}>
        <h1 className="text-heading-6">Settings</h1>
        <Outlet />
      </div>
    </AppTabShell>
  )
}

const Route = createFileRoute('/settings')({
  ...authGatedRouteOptions,
  component: SettingsLayout,
})

export { Route, SettingsLayout }
