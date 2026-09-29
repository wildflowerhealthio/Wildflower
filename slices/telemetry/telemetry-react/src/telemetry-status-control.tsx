import type { TelemetryConsentCopy } from 'branding-core'
import type { JSX } from 'react'
import type { TelemetryConsent } from 'telemetry-core'

import styles from './telemetry-status-control.module.css'

type TelemetryStatusControlProps = {
  /** The visitor's answer, which the control reads out. */
  readonly consent: TelemetryConsent
  /** The dialog's copy, whose switch labels name the switches here too. */
  readonly copy: TelemetryConsentCopy
  /** Called when the visitor presses the control; the caller reopens the dialog. */
  readonly onChange: () => void
}

/** How the status control reads one switch. */
const onOff = (switchedOn: boolean): string => (switchedOn ? 'on' : 'off')

/**
 * What the status control reads for `consent`: each switch by its label with
 * on or off, or just "off" when both are.
 */
const telemetryStatusText = (consent: TelemetryConsent, copy: TelemetryConsentCopy): string => {
  if (!consent.crashReports && !consent.performance) return 'Telemetry: off'
  return (
    `Telemetry: ${copy.crashReports.label} ${onOff(consent.crashReports)}` +
    ` · ${copy.performance.label} ${onOff(consent.performance)}`
  )
}

/**
 * The small "Telemetry: …" control that says what the visitor agreed to send
 * and, when pressed, lets them change it. App chrome places it (the brand bar,
 * or above the site footer) and reopens the consent dialog from `onChange`.
 *
 * @remarks
 * The visible text is the status; the button's accessible name carries that
 * text followed by what pressing it does, "change telemetry settings", so a
 * voice-control user can say the words they see.
 */
const TelemetryStatusControl = ({
  consent,
  copy,
  onChange,
}: TelemetryStatusControlProps): JSX.Element => (
  <button type="button" className={styles['telemetry-status']} onClick={onChange}>
    {telemetryStatusText(consent, copy)}
    <span className="sr-only">, change telemetry settings</span>
  </button>
)

export { TelemetryStatusControl, type TelemetryStatusControlProps }
