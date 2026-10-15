import { Outlet } from '@tanstack/react-router'
import { pageLayoutStyles } from '@wildflowerhealthio/react-tundraish'
import type { JSX } from 'react'

/**
 * The layout the base's routes render into: the page shell. The app mounts
 * the base's `routes/_servers/` under a pathless `_servers` layout route
 * whose component this is.
 */
function BaseLayout(): JSX.Element {
  return (
    <div className={pageLayoutStyles['page']}>
      <Outlet />
    </div>
  )
}

export { BaseLayout }
