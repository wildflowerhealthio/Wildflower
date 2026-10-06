import { createFileRoute } from '@tanstack/react-router'

import { SettingsPage } from '../settings-page.tsx'

/** `/settings`, the base's own settings, for the app rather than any one server. */
export const Route = createFileRoute('/settings')({ component: SettingsPage })
