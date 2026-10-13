import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { PageHeader } from '@wildflowerhealthio/react-tundraish'
import type { JSX } from 'react'

import { DeviceCodeEntryForm } from '../../../screens/device/device-code-entry-form.tsx'

/**
 * The `/settings/authorization/devices` file route — the owner-facing
 * "Authorize a Device" entry screen, reached from the access page. Renders
 * the same {@link DeviceCodeEntryForm} as the public
 * `/authorization/devices` surface but with a back link to the access page,
 * and advances to the in-settings consent route. The auth-gated `/settings`
 * layout keeps this owner-only.
 */
function SettingsDeviceEntryScreen(): JSX.Element {
  const navigate = useNavigate()
  return (
    <>
      <PageHeader title="Enter Code" backHref="/settings/authorization" backLabel="Access" />
      <DeviceCodeEntryForm
        onSubmit={(code) => {
          void navigate({ to: `/settings/authorization/devices/${encodeURIComponent(code)}` })
        }}
      />
    </>
  )
}

export const Route = createFileRoute('/settings/authorization/devices')({
  component: SettingsDeviceEntryScreen,
})
