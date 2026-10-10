import type { TelemetryConsentCopy } from '@wildflowerhealthio/branding-core'
import type { TelemetryConsent } from '@wildflowerhealthio/telemetry-core'
import type { JSX } from 'react'

import { telemetryConsentSummary } from './telemetry-consent-summary.ts'
import styles from './telemetry-status-control.module.css'

type TelemetryStatusControlProps = {
  /** The visitor's answer, which the control reads out. */
  readonly consent: TelemetryConsent
  /** The dialog's copy, whose switch labels name the switches here too. */
  readonly copy: TelemetryConsentCopy
  /** Called when the visitor presses the control; the caller reopens the dialog. */
  readonly onPress: () => void
}

/**
 * What the status control reads for `consent`: the
 * {@link telemetryConsentSummary}, or just "off" when both switches are.
 */
const telemetryStatusText = (consent: TelemetryConsent, copy: TelemetryConsentCopy): string => {
  if (!consent.crashReports && !consent.performance) return 'Telemetry: off'
  return `Telemetry: ${telemetryConsentSummary(consent, copy)}`
}

/**
 * The small "Telemetry: …" control that says what the visitor agreed to send
 * and, when pressed, lets them change it. App chrome places it (the brand bar,
 * or above the site footer) and reopens the consent dialog from `onPress`.
 *
 * @remarks
 * The visible text is the status; the button's accessible name carries that
 * text followed by what pressing it does, "change telemetry settings", so a
 * voice-control user can say the words they see.
 */
const TelemetryStatusControl = ({
  consent,
  copy,
  onPress,
}: TelemetryStatusControlProps): JSX.Element => (
  <button type="button" className={styles['telemetry-status']} onClick={onPress}>
    {telemetryStatusText(consent, copy)}
    <span className="sr-only">, change telemetry settings</span>
  </button>
)

export { TelemetryStatusControl, type TelemetryStatusControlProps }
