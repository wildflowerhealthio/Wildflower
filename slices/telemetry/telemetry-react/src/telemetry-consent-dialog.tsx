import type { TelemetryConsentCopy } from 'branding-core'
import { useState, type JSX } from 'react'
import { Dialog, ToggleSwitch } from 'react-tundraish'
import type { TelemetryConsent } from 'telemetry-core'

import styles from './telemetry-consent-dialog.module.css'

/** The two switches the dialog asks about, as a visitor sets them. */
type ConsentSwitches = Pick<TelemetryConsent, 'crashReports' | 'performance'>

/** Where the switches start the first time a visitor sees the dialog: both off. */
const SWITCHES_OFF: ConsentSwitches = { crashReports: false, performance: false }

type TelemetryConsentDialogProps = {
  /** Whether the dialog is showing. */
  readonly open: boolean
  /** The words the dialog shows (`TELEMETRY_CONSENT_COPY` from `branding-core`). */
  readonly copy: TelemetryConsentCopy
  /** The answer being changed, when reopened; the switches start from it. */
  readonly initial?: ConsentSwitches
  /** Called with the switches as they stand when the visitor presses Continue. */
  readonly onContinue: (switches: ConsentSwitches) => void
}

type TelemetryConsentFormProps = Pick<TelemetryConsentDialogProps, 'copy' | 'onContinue'> & {
  readonly initialSwitches: ConsentSwitches
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
            checked={switches.crashReports}
            onChange={(crashReports) => setSwitches({ ...switches, crashReports })}
          />
          <p className={styles['consent__switch-description']}>{copy.crashReports.description}</p>
        </div>
        <div className={styles['consent__switch']}>
          <ToggleSwitch
            label={copy.performance.label}
            checked={switches.performance}
            onChange={(performance) => setSwitches({ ...switches, performance })}
          />
          <p className={styles['consent__switch-description']}>{copy.performance.description}</p>
        </div>
      </div>
      <p className={styles['consent__text']}>{copy.sessions}</p>
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
 * The dialog is non-dismissable: no ×, and the backdrop and Escape do
 * nothing, so the only way out is Continue. A browser may still close a modal
 * dialog itself (Chrome does on a second Escape with no click in between);
 * the dialog then opens again, since the visitor has not answered.
 *
 * The caller owns `open` and closes it from `onContinue`.
 */
const TelemetryConsentDialog = ({
  open,
  copy,
  initial = SWITCHES_OFF,
  onContinue,
}: TelemetryConsentDialogProps): JSX.Element => {
  // Bumped when the browser closes the dialog while it should be open;
  // remounting the Dialog under a new key shows it again.
  const [browserCloseCount, setBrowserCloseCount] = useState(0)
  return (
    <Dialog
      key={browserCloseCount}
      open={open}
      dismissable={false}
      title={copy.title}
      onClose={() => {
        if (open) setBrowserCloseCount((count) => count + 1)
      }}
    >
      {open ? (
        <TelemetryConsentForm copy={copy} initialSwitches={initial} onContinue={onContinue} />
      ) : null}
    </Dialog>
  )
}

export { TelemetryConsentDialog, type TelemetryConsentDialogProps }
