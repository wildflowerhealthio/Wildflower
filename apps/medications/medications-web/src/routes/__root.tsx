import { createRootRouteWithContext, Outlet } from '@tanstack/react-router'
import { RouteNotFound } from '@wildflowerhealthio/smart-app-react'
import type { JSX } from 'react'

import { AppTitle } from '../app-title.tsx'
import type { RouterContext } from '../router-context.ts'

/** Every page: the app's title over the open route. */
function MedicationsRoot(): JSX.Element {
  return (
    <>
      <AppTitle />
      <Outlet />
    </>
  )
}

/**
 * The root route: `/`, which redirects, the patient picker at
 * `/patients`, every patient's tabs at the top level, one patient's under
 * `/patients/$patientId`, and for a path none of them names, the not-found
 * card.
 */
const Route = createRootRouteWithContext<RouterContext>()({
  component: MedicationsRoot,
  notFoundComponent: () => <RouteNotFound appName="The Medication Viewer" />,
})

export { Route }
