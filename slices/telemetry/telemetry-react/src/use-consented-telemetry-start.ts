import type { TelemetryConsent } from '@wildflowerhealthio/telemetry-core'
import {
  configFromViteEnv,
  initConsentedTelemetry,
  type TelemetryTags,
} from '@wildflowerhealthio/telemetry-web'
import { useRef, useState } from 'react'

/** Options for {@link useConsentedTelemetryStart}. */
interface ConsentedTelemetryStartOptions {
  /**
   * The DSN of the app's own Sentry project, from its own
   * `VITE_SENTRY_DSN_<APP>` build variable. Empty when the build names none,
   * and then nothing is reported whatever the visitor answers; the shared
   * `VITE_SENTRY_DSN` is never read in its place.
   */
  readonly dsn: string
  /**
   * Set on every event once telemetry starts. `tags.app` is also the
   * OpenTelemetry service name.
   */
  readonly tags: TelemetryTags
  /**
   * Called once, the first time an answer starts telemetry: where an app
   * reports what happened before it could report anything (the SMART launch
   * failure a page arrived with).
   */
  readonly onFirstStart?: () => void
}

/** What {@link useConsentedTelemetryStart} gives the app root. */
interface ConsentedTelemetryStart {
  /**
   * Whether an answer has started telemetry. It stays `true` for the page's
   * life, whatever later answers say: the SDK's own hooks drop what a
   * withdrawn switch no longer covers.
   */
  readonly telemetryStarted: boolean
  /** Starts telemetry as far as `consent` allows: the `TelemetryConsentGate`'s `onDecided`. */
  readonly startTelemetry: (consent: TelemetryConsent) => void
}

/**
 * Starts an app's telemetry from the visitor's answer, reporting to the app's
 * own Sentry project with its own tags.
 *
 * @remarks
 * `startTelemetry` hands `initConsentedTelemetry` the build's config
 * (`configFromViteEnv`) with the DSN replaced by `dsn` and the service named
 * `tags.app`, so an undecided or declined answer starts nothing. Call it with
 * every answer (the gate's `onDecided` does): the SDK's hooks follow the
 * latest one. `onFirstStart` runs after the first answer that starts
 * telemetry, and never again on this mount.
 */
const useConsentedTelemetryStart = ({
  dsn,
  tags,
  onFirstStart,
}: ConsentedTelemetryStartOptions): ConsentedTelemetryStart => {
  const [telemetryStarted, setTelemetryStarted] = useState(false)
  const firstStartHandled = useRef(false)

  const startTelemetry = (consent: TelemetryConsent): void => {
    const started = initConsentedTelemetry({
      consent,
      config: configFromViteEnv({ sentry: { dsn }, otel: { serviceName: tags.app } }),
      tags,
    })
    if (!started) return
    setTelemetryStarted(true)
    if (firstStartHandled.current) return
    firstStartHandled.current = true
    onFirstStart?.()
  }

  return { telemetryStarted, startTelemetry }
}

export { useConsentedTelemetryStart }
export type { ConsentedTelemetryStart, ConsentedTelemetryStartOptions }
