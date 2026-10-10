import type { TelemetryConsentCopy } from '@wildflowerhealthio/branding-core'
import type { ConsentStorage, TelemetryConsent } from '@wildflowerhealthio/telemetry-core'
import { useMemo, type JSX, type ReactNode } from 'react'

import { TelemetryConsentContext } from './telemetry-consent-context.ts'
import { TelemetryConsentDialog } from './telemetry-consent-dialog.tsx'
import { useTelemetryConsent } from './use-telemetry-consent.ts'

type TelemetryConsentGateProps = {
  /** Where the answer is kept. Defaults to the page's `window.localStorage`. */
  readonly storage?: ConsentStorage
  /** The dialog's words and copy version (`TELEMETRY_CONSENT_COPY` from `branding-core`). */
  readonly copy: TelemetryConsentCopy
  /**
   * Called with the answer once it is known (a current stored one on mount,
   * and each new one); the app starts its telemetry here with
   * `initConsentedTelemetry`.
   */
  readonly onDecided: (consent: TelemetryConsent) => void
  /** The app, rendered only once the visitor has answered. */
  readonly children: ReactNode
}

/**
 * Holds an app behind the telemetry consent dialog until the visitor answers
 * it, then renders the app with the answer, `copy` and a way to change it in
 * {@link TelemetryConsentContext}. The answer is kept in `storage`.
 *
 * @remarks
 * **`children` never mount before a decision.** While no answer for
 * `copy.version` is stored, the gate renders only the dialog: nothing in the
 * app runs, fetches, or reports before the visitor has said what may be sent.
 * A stored current answer skips the dialog and renders `children` at once.
 *
 * Reopening (`useTelemetryConsentControls().reopen`) shows the dialog over
 * the app with the switches set to the current answer; the app stays
 * mounted, and Continue replaces the answer and calls `onDecided` again.
 */
const TelemetryConsentGate = ({
  storage = window.localStorage,
  copy,
  onDecided,
  children,
}: TelemetryConsentGateProps): JSX.Element => {
  const { consent, dialogOpen, decide, reopen } = useTelemetryConsent({
    storage,
    version: copy.version,
    onDecided,
  })
  const controls = useMemo(
    () => (consent === undefined ? undefined : { consent, copy, reopen }),
    [consent, copy, reopen]
  )
  return (
    <>
      {controls === undefined ? null : (
        <TelemetryConsentContext value={controls}>{children}</TelemetryConsentContext>
      )}
      <TelemetryConsentDialog open={dialogOpen} copy={copy} initial={consent} onContinue={decide} />
    </>
  )
}

export { TelemetryConsentGate, type TelemetryConsentGateProps }
