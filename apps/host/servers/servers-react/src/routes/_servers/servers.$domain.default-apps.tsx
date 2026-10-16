import { createFileRoute } from '@tanstack/react-router'

import { ServerDefaultAppsTab } from '../../server-default-apps-tab.tsx'

/** `/servers/$domain/default-apps`, the server page's Default Apps tab. */
export const Route = createFileRoute('/_servers/servers/$domain/default-apps')({
  component: ServerDefaultAppsTab,
})
