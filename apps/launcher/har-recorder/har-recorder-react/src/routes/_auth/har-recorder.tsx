import { createFileRoute, Outlet } from '@tanstack/react-router'
import { pageLayoutStyles } from '@wildflowerhealthio/react-tundraish'
import type { JSX } from 'react'

/**
 * Recorder-level layout route: wraps the page beneath it in the shared
 * `pageLayoutStyles['page']` shell, the same arrangement `collector.tsx` uses.
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
