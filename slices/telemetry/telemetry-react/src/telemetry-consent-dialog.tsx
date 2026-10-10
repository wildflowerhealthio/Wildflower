import type { TelemetryConsentCopy } from '@wildflowerhealthio/branding-core'
import { Dialog, ToggleSwitch } from '@wildflowerhealthio/react-tundraish'
import { useId, useState, type JSX } from 'react'

import type { TelemetryConsentSwitches } from './use-telemetry-consent.ts'
import styles from './telemetry-consent-dialog.module.css'

/** Where the switches start the first time a visitor sees the dialog: both off. */
const SWITCHES_OFF: TelemetryConsentSwitches = { crashReports: false, performance: false }

type TelemetryConsentDialogProps = {
  /** Whether the dialog is showing. */
  readonly open: boolean
  /** The words the dialog shows (`TELEMETRY_CONSENT_COPY` from `branding-core`). */
  readonly copy: TelemetryConsentCopy
  /** The answer being changed, when reopened; the switches start from it. */
  readonly initial?: TelemetryConsentSwitches
  /** Called with the switches as they stand when the visitor presses Continue. */
  readonly onContinue: (switches: TelemetryConsentSwitches) => void
}

type TelemetryConsentFormProps = Pick<TelemetryConsentDialogProps, 'copy' | 'onContinue'> & {
  readonly initialSwitches: TelemetryConsentSwitches
}

/**
 * The dialog's contents: the warning, the two switches and Continue. Mounted
 * each time the dialog opens, so the switches start from `initialSwitches`.
 */
const TelemetryConsentForm = ({
  copy,
  initialSwitches,
  onContinue,
}: TelemetryConsentFormProps): JSX.Element => {
  const [switches, setSwitches] = useState(initialSwitches)
  const crashReportsDescriptionId = useId()
  const performanceDescriptionId = useId()
  return (
    <div className={styles['consent']}>
      <div className={styles['consent__warning']}>
        {copy.warning.map((paragraph) => (
          <p key={paragraph} className={styles['consent__warning-paragraph']}>
            {paragraph}
          </p>
        ))}
      </div>
      <p className={styles['consent__text']}>{copy.destination}</p>
      <div className={styles['consent__switches']}>
        <div className={styles['consent__switch']}>
          <ToggleSwitch
            label={copy.crashReports.label}
            describedBy={crashReportsDescriptionId}
            checked={switches.crashReports}
            onChange={(crashReports) => setSwitches({ ...switches, crashReports })}
          />
          <p id={crashReportsDescriptionId} className={styles['consent__switch-description']}>
            {copy.crashReports.description}
          </p>
        </div>
        <div className={styles['consent__switch']}>
          <ToggleSwitch
            label={copy.performance.label}
            describedBy={performanceDescriptionId}
            checked={switches.performance}
            onChange={(performance) => setSwitches({ ...switches, performance })}
          />
          <p id={performanceDescriptionId} className={styles['consent__switch-description']}>
            {copy.performance.description}
          </p>
        </div>
      </div>
      <p className={styles['consent__text']}>{copy.sessions}</p>
      <p className={styles['consent__text']}>{copy.changeLater}</p>
      <button type="button" className="button-2 filled" onClick={() => onContinue(switches)}>
        {copy.continueLabel}
      </button>
    </div>
  )
}

/**
 * The telemetry consent dialog: the synthetic-data warning, where reports go,
 * a switch each for crash reports and performance data, and one Continue
 * button. Both switches start off, and Continue with both off is an answer
 * like any other.
 *
 * @remarks
 * The dialog is react-tundraish's non-dismissable `Dialog`: no ×, the
 * backdrop and Escape do nothing, and if the browser closes it anyway it
 * shows itself again with the switches as the visitor left them. The only
 * way out is Continue; the caller owns `open` and closes it from
 * `onContinue`.
 */
const TelemetryConsentDialog = ({
  open,
  copy,
  initial = SWITCHES_OFF,
  onContinue,
}: TelemetryConsentDialogProps): JSX.Element => (
  <Dialog
    open={open}
    dismissable={false}
    title={copy.title}
    // Only a close the caller asked for (`open` set false after Continue)
    // reaches here, and the caller has already acted on it.
    onClose={() => undefined}
  >
    {open ? (
      <TelemetryConsentForm copy={copy} initialSwitches={initial} onContinue={onContinue} />
    ) : null}
  </Dialog>
)

export { TelemetryConsentDialog, type TelemetryConsentDialogProps }
