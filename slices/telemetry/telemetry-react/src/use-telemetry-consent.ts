import { useCallback, useEffectEvent, useLayoutEffect, useState } from 'react'
import {
  readConsent,
  type ConsentStorage,
  type TelemetryConsent,
  writeConsent,
} from 'telemetry-core'

/** The two switches of the telemetry consent dialog, as the visitor set them. */
type TelemetryConsentSwitches = Pick<TelemetryConsent, 'crashReports' | 'performance'>

/** Options for {@link useTelemetryConsent}. */
interface UseTelemetryConsentOptions {
  /** Where the answer is kept: `window.localStorage` in an app. */
  readonly storage: ConsentStorage
  /** The copy version of the dialog the app shows; an answer to another one re-asks. */
  readonly version: number
  /**
   * Called with the visitor's answer once it is known: on mount when a
   * current answer is stored, and after every {@link TelemetryConsentPrompt.decide}.
   * The app starts or narrows its telemetry here.
   */
  readonly onDecided: (consent: TelemetryConsent) => void
}

/** Where the visitor stands with the telemetry consent dialog, and how to move them on. */
interface TelemetryConsentPrompt {
  /** The visitor's answer, or `undefined` while they have not given one. */
  readonly consent: TelemetryConsent | undefined
  /** Whether the dialog should be showing: no answer yet, or reopened. */
  readonly dialogOpen: boolean
  /** Keep the visitor's switch settings as their answer and close the dialog. */
  readonly decide: (switches: TelemetryConsentSwitches) => void
  /** Show the dialog again over an answer already given, so the visitor can change it. */
  readonly reopen: () => void
}

/**
 * The visitor's telemetry consent, read from `storage` and written back
 * through `telemetry-core`.
 *
 * @returns The answer so far, whether the dialog should show, and the two
 *   ways to move on: `decide` and `reopen`
 *
 * @remarks
 * `storage` is read once, on mount: an answer for `version` skips the dialog,
 * and anything else (nothing stored, another version, a record that does not
 * decode) leaves it open. `decide` stamps the switches with `version` and the
 * current time, writes the record, and closes the dialog; a storage error
 * throws from it rather than leaving an answer that was never kept.
 *
 * `onDecided` runs from a layout effect whenever the answer changes: after
 * the storage write, and before any passive effect (`useEffect`) of the app
 * the answer reveals, so telemetry has started before the app's first fetch.
 * It may run more than once with the same answer (React's strict mode mounts
 * twice); `initConsentedTelemetry` is safe to call again with an unchanged
 * answer.
 */
const useTelemetryConsent = ({
  storage,
  version,
  onDecided,
}: UseTelemetryConsentOptions): TelemetryConsentPrompt => {
  const [consent, setConsent] = useState(() => readConsent(storage, version))
  const [reopened, setReopened] = useState(false)

  const announceDecision = useEffectEvent(onDecided)
  useLayoutEffect(() => {
    if (consent !== undefined) announceDecision(consent)
  }, [consent])

  const decide = useCallback(
    (switches: TelemetryConsentSwitches): void => {
      const decidedConsent: TelemetryConsent = {
        version,
        crashReports: switches.crashReports,
        performance: switches.performance,
        decidedAt: new Date().toISOString(),
      }
      writeConsent(storage, decidedConsent)
      setConsent(decidedConsent)
      setReopened(false)
    },
    [storage, version]
  )

  const reopen = useCallback((): void => {
    setReopened(true)
  }, [])

  return { consent, dialogOpen: consent === undefined || reopened, decide, reopen }
}

export { useTelemetryConsent }
export type { TelemetryConsentPrompt, TelemetryConsentSwitches, UseTelemetryConsentOptions }
