import { createFileRoute } from '@tanstack/react-router'

import { BaseLayout } from '../../base-layout.tsx'
import { BASE_SCREEN_STATIC_DATA } from '../../base-screen.ts'

/**
 * `/servers`, the servers on this device: the base's page shell around the
 * server list, Add server and each server's page.
 */
export const Route = createFileRoute('/servers')({
  staticData: BASE_SCREEN_STATIC_DATA,
  component: BaseLayout,
})
