import { createFileRoute } from '@tanstack/react-router'
import { Schema } from 'effect'

import { ServerListPage } from '../../server-list-page.tsx'
import { ServerListSearch } from '../../server-list-walkthrough.ts'

/**
 * `/servers/`, the base's home: the servers on this device, with the Host's
 * walkthrough, which `?walkthrough=show` shows again.
 */
export const Route = createFileRoute('/servers/')({
  validateSearch: Schema.standardSchemaV1(ServerListSearch),
  component: ServerListPage,
})
