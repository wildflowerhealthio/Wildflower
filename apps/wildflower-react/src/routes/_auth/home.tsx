import { createFileRoute, Outlet } from '@tanstack/react-router'
import type { JSX } from 'react'
import { pageLayoutStyles } from 'react-tundraish'

/**
 * Apps landing layout. Wraps the apps-slice landing screen in the
 * shared `pageLayoutStyles['page']` shell so the leaf renders content
 * only — mirrors `collector.tsx`.
 *
 * Owned at the app level (not in the slice) for symmetry with the two
 * `gatekeeper.tsx` layouts: the router-plugin's `physical()` mounts
 * compute generated-variable names from the in-mount path only, so
 * keeping slice-level layouts requires us to avoid sibling collisions
 * across the `_auth/` and `_open/` buckets. Owning every section layout
 * at the app level removes that constraint entirely.
 */
function AppsHomeLayout(): JSX.Element {
  return (
    <div className={pageLayoutStyles['page']}>
      <Outlet />
    </div>
  )
}

export const Route = createFileRoute('/_auth/home')({
  component: AppsHomeLayout,
})
