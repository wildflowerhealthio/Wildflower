import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { PageHeader } from '@wildflowerhealthio/react-tundraish'
import type { JSX } from 'react'

import { DeviceCodeEntryForm } from '../../../screens/device/device-code-entry-form.tsx'

/**
 * The launcher's public device-code entry screen. The RFC 8628
 * `verification_uri` is the authorization server's own device page
 * (`/oauth/device`); this screen is the launcher's way to the same decision,
 * reached by its address. Renders the shared {@link DeviceCodeEntryForm} with
 * no back link (nothing in the app links here, so there is nowhere in-app to
 * go back to). Submitting advances to the consent route.
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
