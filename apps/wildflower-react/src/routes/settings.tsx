import { Outlet } from '@tanstack/react-router'
import type { JSX } from 'react'
import { pageLayoutStyles } from 'react-tundraish'

/**
 * `/settings` layout — persistent "Settings" header that stays visible
 * across child routes. The slice-contributed `/settings/<slice>/…`
 * subtrees render in the `<Outlet />` below the header.
 */
function SettingsLayout(): JSX.Element {
  return (
    <div className={pageLayoutStyles['page']}>
      <h1 className="text-heading-4">Settings</h1>
      <Outlet />
    </div>
  )
}

export { SettingsLayout }
