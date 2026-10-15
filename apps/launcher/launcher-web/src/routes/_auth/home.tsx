import { createFileRoute, Outlet } from '@tanstack/react-router'
import { pageLayoutStyles } from '@wildflowerhealthio/react-tundraish'
import type { JSX } from 'react'

/**
 * Apps landing layout. Wraps the apps-slice landing screen in the
 * shared `pageLayoutStyles['page']` shell so the leaf renders content
 * only.
 *
 * Owned at the app level (not in the package): the router-plugin's
 * `physical()` mounts compute generated-variable names from the in-mount
 * path only, so package-level section layouts could collide across
 * buckets. Owning every section layout at the app level removes that
 * constraint.
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
