import { createRootRouteWithContext, Outlet, useLocation } from '@tanstack/react-router'
import { RouteNotFound } from '@wildflowerhealthio/smart-app-react'
import type { JSX } from 'react'

import { AppTitle } from '../app-title.tsx'
import type { RouterContext } from '../router-context.ts'

/**
 * Every page: the app's title over the open route, except on the
 * introduction at `/`, which names the app itself.
 */
function StrengthRoot(): JSX.Element {
  const onIntroduction = useLocation({ select: (location) => location.pathname === '/' })
  return (
    <>
      {onIntroduction ? null : <AppTitle />}
      <Outlet />
    </>
  )
}

/**
 * The root route: the introduction at `/`, the patient picker at
 * `/patients`, a lifter's tabs under `/patients/$patientId`, every patient's
 * workouts at `/workouts`, and for a path none of them names, the not-found
 * card.
 */
const Route = createRootRouteWithContext<RouterContext>()({
  component: StrengthRoot,
  notFoundComponent: () => <RouteNotFound appName="Wildflower Strength" />,
})

export { Route }
