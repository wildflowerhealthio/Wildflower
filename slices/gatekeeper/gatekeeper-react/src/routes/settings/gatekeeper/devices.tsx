import { createFileRoute, useNavigate } from '@tanstack/react-router'
import type { JSX } from 'react'
import { PageHeader } from 'react-tundraish'

import { DeviceCodeEntryForm } from '../../../screens/device/device-code-entry-form.tsx'

/**
 * The `/settings/gatekeeper/devices` file route — the owner-facing
 * "Authorize a Device" entry screen, reached from the access page. Renders
 * the same {@link DeviceCodeEntryForm} as the public
 * `/gatekeeper/devices` surface but with a back link to the access page,
 * and advances to the in-settings consent route. The auth-gated `/settings`
 * layout keeps this owner-only.
 */
function SettingsDeviceEntryScreen(): JSX.Element {
  const navigate = useNavigate()
  return (
    <>
      <PageHeader title="Enter Code" backHref="/settings/gatekeeper" backLabel="Access" />
      <DeviceCodeEntryForm
        onSubmit={(code) => {
          void navigate({ to: `/settings/gatekeeper/devices/${encodeURIComponent(code)}` })
        }}
      />
    </>
  )
}

export const Route = createFileRoute('/settings/gatekeeper/devices')({
  component: SettingsDeviceEntryScreen,
})
