import { createRootRouteWithContext, Outlet, useRouteContext } from '@tanstack/react-router'
import type { JSX } from 'react'
import { pageLayoutStyles } from 'react-tundraish'

import { ConsentSheet } from '../consent-sheet.tsx'
import type { RouterContext } from '../router-context.ts'

/**
 * The base's page shell, which every screen renders into, with the consent
 * sheet over whichever screen is showing.
 */
function BaseShell(): JSX.Element {
  const runHostCommand = useRouteContext({
    from: '__root__',
    select: (context: RouterContext) => context.runHostCommand,
  })
  const listenToHostEvent = useRouteContext({
    from: '__root__',
    select: (context: RouterContext) => context.listenToHostEvent,
  })
  return (
    <div className={pageLayoutStyles['page']}>
      <Outlet />
      <ConsentSheet runHostCommand={runHostCommand} listenToHostEvent={listenToHostEvent} />
    </div>
  )
}

export const Route = createRootRouteWithContext<RouterContext>()({ component: BaseShell })
