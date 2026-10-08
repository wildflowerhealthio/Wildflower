import { createRootRouteWithContext, Outlet } from '@tanstack/react-router'
import type { JSX } from 'react'
import { pageLayoutStyles } from 'react-tundraish'

import { ConsentSheet } from '../consent-sheet.tsx'
import type { RouterContext } from '../router-context.ts'

/**
 * The base's page shell, which every screen renders into, with the consent
 * sheet over whichever screen is showing.
 */
function BaseShell(): JSX.Element {
  const { runHostCommand, listenToHostEvent } = Route.useRouteContext()
  return (
    <div className={pageLayoutStyles['page']}>
      <Outlet />
      <ConsentSheet runHostCommand={runHostCommand} listenToHostEvent={listenToHostEvent} />
    </div>
  )
}

export const Route = createRootRouteWithContext<RouterContext>()({ component: BaseShell })
