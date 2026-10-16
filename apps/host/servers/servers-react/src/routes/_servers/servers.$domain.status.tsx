import { createFileRoute } from '@tanstack/react-router'

import { ServerStatusTab } from '../../server-status-tab.tsx'

/** `/servers/$domain/status`, the server page's Status tab. */
export const Route = createFileRoute('/_servers/servers/$domain/status')({
  component: ServerStatusTab,
})
