import { createFileRoute, Outlet } from '@tanstack/react-router'
import type { JSX } from 'react'
import { pageLayoutStyles } from 'react-tundraish'

/**
 * Collector-level layout route. Sits at `/_auth/collector` and nests every
 * page under `collector/` (the accounts list, the new-account form, and the
 * edit-account form) beneath a single shared page shell. Centralising the
 * `pageLayoutStyles['page']` wrapper here means the individual pages render
 * just their content via `<Outlet />` and no longer repeat the wrapper.
 *
 * The slice's own `__root.tsx` is not used in `apps/wildflower-react`; the
 * app's virtual-route config mounts this slice's `_auth/` directory under the
 * app's `_auth` layout, so this layout takes effect both standalone and in
 * the composed app tree.
 */
function CollectorLayout(): JSX.Element {
  return (
    <div className={pageLayoutStyles['page']}>
      <Outlet />
    </div>
  )
}

export const Route = createFileRoute('/_auth/collector')({
  component: CollectorLayout,
})
