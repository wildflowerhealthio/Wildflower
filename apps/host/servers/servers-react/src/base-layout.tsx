import { Outlet, useRouteContext } from '@tanstack/react-router'
import { pageLayoutStyles } from '@wildflowerhealthio/react-tundraish'
import type { JSX } from 'react'

import { ConsentSheet } from './consent-sheet.tsx'
import type { RouterContext } from './router-context.ts'

/**
 * The layout the base's routes render into: the page shell, with the consent
 * sheet over whichever of the base's screens is showing. The app mounts the
 * base's `routes/_servers/` under a pathless `_servers` layout route whose
 * component this is.
 */
function BaseLayout(): JSX.Element {
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

export { BaseLayout }
