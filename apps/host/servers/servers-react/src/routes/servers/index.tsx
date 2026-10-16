import { createFileRoute } from '@tanstack/react-router'

import { ServerListPage } from '../../server-list-page.tsx'

/** `/servers/`, the base's home: the servers on this device. */
export const Route = createFileRoute('/servers/')({ component: ServerListPage })
