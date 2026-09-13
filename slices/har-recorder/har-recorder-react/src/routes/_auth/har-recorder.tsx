import { createFileRoute, Outlet } from '@tanstack/react-router'
import type { JSX } from 'react'
import { pageLayoutStyles } from 'react-tundraish'

/**
 * Recorder-level layout route. Sits at `/_auth/har-recorder` and wraps the
 * page beneath it in the shared `pageLayoutStyles['page']` shell, so the leaf
 * renders its content only — the same arrangement `collector.tsx` uses.
 *
 * The slice's own `__root.tsx` is not used in `apps/wildflower-react`; that
 * app's virtual-route config mounts this slice's `_auth/` directory under its
 * own `_auth` layout, so this layout takes effect both standalone and in the
 * composed tree.
 */
function HarRecorderLayout(): JSX.Element {
  return (
    <div className={pageLayoutStyles['page']}>
      <Outlet />
    </div>
  )
}

export const Route = createFileRoute('/_auth/har-recorder')({
  component: HarRecorderLayout,
})
