import { createFileRoute, Outlet } from '@tanstack/react-router'
import type { JSX } from 'react'
import { pageLayoutStyles } from 'react-tundraish'

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
