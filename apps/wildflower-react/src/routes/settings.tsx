import { createFileRoute, Outlet } from '@tanstack/react-router'
import type { JSX } from 'react'
import { pageLayoutStyles } from 'react-tundraish'

import { authGatedRouteOptions } from '../session/auth-gated-route-options.ts'
import { AppTabShell } from '../session/tab-bar.tsx'

/**
 * `/settings` layout — the persistent tab shell plus the shared page
 * shell that the slice-contributed `/settings/<slice>/…` subtrees render
 * into via `<Outlet />`. The layout deliberately renders no heading of
 * its own: each child page owns a single `<PageHeader>` (the index's
 * "Settings", a sub-page's own short title + back link), so a settings
 * page never stacks the section title on top of its own — the
 * double-header this layout used to cause.
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
