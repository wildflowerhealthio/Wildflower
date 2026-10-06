import { createRootRouteWithContext, Outlet } from '@tanstack/react-router'
import type { JSX } from 'react'
import { pageLayoutStyles } from 'react-tundraish'

import type { RouterContext } from '../router-context.ts'

/** The base's page shell, which every screen renders into. */
function BaseShell(): JSX.Element {
  return (
    <div className={pageLayoutStyles['page']}>
      <Outlet />
    </div>
  )
}

export const Route = createRootRouteWithContext<RouterContext>()({ component: BaseShell })
