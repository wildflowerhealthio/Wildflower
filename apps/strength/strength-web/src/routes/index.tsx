import { createFileRoute } from '@tanstack/react-router'
import { appRootRedirect, launchStartRoute } from '@wildflowerhealthio/smart-app-react'

/**
 * `/`, which is never a page: it replaces itself with the route the launch
 * started on, else the launch's patient's page, else the patient picker
 * (`launchStartRoute`). A completed launch's callback lands here.
 */
const Route = createFileRoute('/')({
  beforeLoad: ({ context: { client } }) => {
    throw appRootRedirect(launchStartRoute(client))
  },
})

export { Route }
