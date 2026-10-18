import { createRootRouteWithContext, Outlet } from '@tanstack/react-router'
import { NoPageCard } from '@wildflowerhealthio/smart-app-react'
import type { JSX } from 'react'

import { AppTitle } from '../app-title.tsx'
import type { RouterContext } from '../router-context.ts'

/** Every page: the app's title over the open route. */
function StrengthRoot(): JSX.Element {
  return (
    <>
      <AppTitle />
      <Outlet />
    </>
  )
}

/**
 * The root route: `/`, which redirects, the patient picker at
 * `/patients`, a lifter's tabs under `/patients/$patientId`, every patient's
 * workouts at `/workouts`, and for a path none of them names (one under a
 * patient too: the router's `notFoundMode` is `'root'`), the no-page card.
 */
const Route = createRootRouteWithContext<RouterContext>()({
  component: StrengthRoot,
  notFoundComponent: NoPageCard,
})

export { Route }
