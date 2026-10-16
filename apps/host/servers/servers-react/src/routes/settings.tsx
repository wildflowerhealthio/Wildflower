import { createFileRoute } from '@tanstack/react-router'
import type { JSX } from 'react'

import { BaseLayout } from '../base-layout.tsx'
import { BASE_SCREEN_STATIC_DATA } from '../base-screen.ts'
import { SettingsPage } from '../settings-page.tsx'

/** Host Settings in the base's page shell. */
function SettingsRoute(): JSX.Element {
  return (
    <BaseLayout>
      <SettingsPage />
    </BaseLayout>
  )
}

/** `/settings`, the base's Host Settings, for the app rather than any one server. */
export const Route = createFileRoute('/settings')({
  staticData: BASE_SCREEN_STATIC_DATA,
  component: SettingsRoute,
})
