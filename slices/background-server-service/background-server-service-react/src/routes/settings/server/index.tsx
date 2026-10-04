import { createFileRoute } from '@tanstack/react-router'

import { ServerSettingsPage } from '../../../server-settings-page.tsx'

/**
 * `/settings/server`. No loader: the page renders the host's status snapshot
 * from the app's store, and reads the tunnel only while the server runs.
 */
export const Route = createFileRoute('/settings/server/')({
  component: ServerSettingsPage,
})
