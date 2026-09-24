import { createFileRoute, useNavigate } from '@tanstack/react-router'
import type { JSX } from 'react'
import { PageHeader } from 'react-tundraish'

import { DeviceCodeEntryForm } from '../../../screens/device/device-code-entry-form.tsx'

/**
 * Public device-code entry screen — the RFC 8628 `verification_uri` an
 * owner reaches from another device. Renders the shared
 * {@link DeviceCodeEntryForm} with no back link (this surface is entered
 * directly via the published URL, so there is nowhere in-app to go back
 * to). Submitting advances to the public consent route.
 *
 * The owner-facing equivalent (`/settings/gatekeeper/devices`) renders the
 * same form with a back link to the access page — same inner content,
 * different chrome.
 */
function DeviceEntryScreen(): JSX.Element {
  const navigate = useNavigate()
  return (
    <>
      <PageHeader title="Enter Code" />
      <DeviceCodeEntryForm
        onSubmit={(code) => {
          void navigate({ to: `/gatekeeper/devices/${encodeURIComponent(code)}` })
        }}
      />
    </>
  )
}

/**
 * The `/gatekeeper/devices` file route — the device-code entry screen,
 * reachable without a bearer.
 */
export const Route = createFileRoute('/_open/gatekeeper/devices')({
  component: DeviceEntryScreen,
})
