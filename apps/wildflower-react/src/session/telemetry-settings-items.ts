import { TELEMETRY_CONSENT_COPY } from 'branding-core'
import { useContext } from 'react'
import type { SettingsItem } from 'shared-structures-react'
import { TelemetryConsentContext, telemetryConsentSummary } from 'telemetry-react'

/**
 * The `/settings` Telemetry row: the visitor's answer as its subtitle, and
 * pressing it reopens the consent dialog, whose Continue replaces the answer.
 *
 * @returns The one row inside a `TelemetryConsentGate`, which only `main-web`
 *   mounts (`WebEntryRoot`); none outside one, as on `main-tauri`, whose
 *   telemetry the consent dialog does not govern
 */
const useTelemetrySettingsItems = (): readonly SettingsItem[] => {
  const consentControls = useContext(TelemetryConsentContext)
  if (consentControls === null) return []
  return [
    {
      id: 'telemetry',
      title: 'Telemetry',
      subtitle: telemetryConsentSummary(consentControls.consent, TELEMETRY_CONSENT_COPY),
      onClick: consentControls.reopen,
    },
  ]
}

export { useTelemetrySettingsItems }
