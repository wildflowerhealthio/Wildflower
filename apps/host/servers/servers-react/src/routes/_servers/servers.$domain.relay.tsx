import { createFileRoute } from '@tanstack/react-router'

import { ServerRelayTab } from '../../server-relay-tab.tsx'

/** `/servers/$domain/relay`, the server page's Relay tab. */
export const Route = createFileRoute('/_servers/servers/$domain/relay')({
  component: ServerRelayTab,
})
