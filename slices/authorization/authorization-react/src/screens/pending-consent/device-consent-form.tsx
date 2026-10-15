import type { JSX } from 'react'

import { useDeviceConsentMutation, type DeviceConsent } from '../../queries/index.ts'
import { DeviceConsentCard } from './device-consent-card.tsx'

interface DeviceConsentFormProps {
  readonly consent: DeviceConsent
  readonly onDone: () => void
}

/**
 * The {@link DeviceConsentCard} on the router's authed runner, for the
 * standalone `/authorization/devices/:userCode` route, which navigates away on
 * `onDone`: the decision goes through {@link useDeviceConsentMutation}.
 */
const DeviceConsentForm = ({ consent, onDone }: DeviceConsentFormProps): JSX.Element => {
  const consentMutation = useDeviceConsentMutation()
  return <DeviceConsentCard consent={consent} consentMutation={consentMutation} onDone={onDone} />
}

export { DeviceConsentForm }
export type { DeviceConsentFormProps }
