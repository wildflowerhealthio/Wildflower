import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { PageHeader } from '@wildflowerhealthio/react-tundraish'
import type { JSX } from 'react'

import { DeviceCodeEntryForm } from '../../../screens/device/device-code-entry-form.tsx'

/**
 * Public device-code entry screen — the RFC 8628 `verification_uri` an
 * owner reaches from another device. Renders the shared
 * {@link DeviceCodeEntryForm} with no back link (this surface is entered
 * directly via the published URL, so there is nowhere in-app to go back
 * to). Submitting advances to the public consent route.
 */
function DeviceEntryScreen(): JSX.Element {
  const navigate = useNavigate()
  return (
    <>
      <PageHeader title="Enter Code" />
      <DeviceCodeEntryForm
        onSubmit={(code) => {
          void navigate({ to: `/authorization/devices/${encodeURIComponent(code)}` })
        }}
      />
    </>
  )
}

/**
 * The `/authorization/devices` file route — the device-code entry screen,
 * reachable without a bearer.
 */
export const Route = createFileRoute('/_open/authorization/devices')({
  component: DeviceEntryScreen,
})
