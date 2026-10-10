import type { SettingsItem } from '@wildflowerhealthio/shared-structures-react'
import {
  TelemetryConsentContext,
  telemetryConsentSummary,
} from '@wildflowerhealthio/telemetry-react'
import { useContext } from 'react'

/**
 * The `/settings` Telemetry row: the user's answer, read by the switch labels
 * of the gate's copy, as its subtitle, and pressing it reopens the consent
 * dialog, whose Continue replaces the answer.
 *
 * @returns The one row inside a `TelemetryConsentGate`, which both entries
 *   mount (`ConsentedEntryRoot`); none outside one
 */
const useTelemetrySettingsItems = (): readonly SettingsItem[] => {
  const consentControls = useContext(TelemetryConsentContext)
  if (consentControls === null) return []
  return [
    {
      id: 'telemetry',
      title: 'Telemetry',
      subtitle: telemetryConsentSummary(consentControls.consent, consentControls.copy),
      onClick: consentControls.reopen,
    },
  ]
}

export { useTelemetrySettingsItems }
