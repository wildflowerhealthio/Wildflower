import { createFileRoute } from '@tanstack/react-router'

import { ServerAccessTab } from '../../server-access-tab.tsx'

/** `/servers/$domain/access`, the server page's Access tab. */
export const Route = createFileRoute('/_servers/servers/$domain/access')({
  component: ServerAccessTab,
})
