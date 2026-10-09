import { createFileRoute } from '@tanstack/react-router'

import { AddServerPage } from '../add-server-page.tsx'

/**
 * `/servers/new`, Add server: a step at a time, from the relay to the
 * server added.
 */
export const Route = createFileRoute('/servers/new')({ component: AddServerPage })
