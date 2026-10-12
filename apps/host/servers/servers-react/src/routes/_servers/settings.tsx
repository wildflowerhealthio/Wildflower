import { createFileRoute } from '@tanstack/react-router'

import { SettingsPage } from '../../settings-page.tsx'

/** `/settings`, the base's Host Settings, for the app rather than any one server. */
export const Route = createFileRoute('/_servers/settings')({ component: SettingsPage })
