import { WILDFLOWER_HOST_TELEMETRY_CONSENT_COPY } from '@wildflowerhealthio/branding-core'
import {
  enableBackgroundSessionRecovery,
  type BackgroundServiceStartConfig,
  TauriInvoke,
} from '@wildflowerhealthio/servers-core-js'
import type { ConsentStorage } from '@wildflowerhealthio/telemetry-core'
import {
  CrashReportingBoundary,
  TelemetryConsentGate,
  useConsentedTelemetryStart,
} from '@wildflowerhealthio/telemetry-react'
import { type Context, Effect } from 'effect'
import { useEffect, type JSX, type ReactNode } from 'react'

/** Where the base's telemetry goes, once the user consents to it. */
interface BaseTelemetry {
  /**
   * The DSN of the base's Sentry project, from the app's own build variable.
   * Empty when the build names none, and then nothing is reported whatever
   * the user answers.
   */
  readonly dsn: string
  /** The `app` tag on every event, and the OpenTelemetry service name. */
  readonly app: string
}

/** Props for {@link BaseGate}. */
interface BaseGateProps {
  /** How the base calls the host: `invoke` from `@tauri-apps/api/core`. */
  readonly invoke: Context.Tag.Service<TauriInvoke>
  /**
   * How the host's unit runner starts its background session, from the app's
   * `tauri-shared-config.json`, which the host reads too.
   */
  readonly backgroundServiceStartConfig: BackgroundServiceStartConfig
  /** Where the base's telemetry goes once the user consents to it. */
  readonly telemetry: BaseTelemetry
  /** Where the consent answer is kept. Defaults to the webview's `localStorage`. */
  readonly storage?: ConsentStorage
  /** The app, its router over the base's routes included. */
  readonly children: ReactNode
}

/**
 * Record, once the base starts, that the host's background session should
 * keep running, so the background-service plugin starts it again after the OS
 * ends the app. The servers run either way, so a failure only costs those
 * restarts, and is logged.
 */
const useBackgroundSessionRecovery = (
  invoke: Context.Tag.Service<TauriInvoke>,
  backgroundServiceStartConfig: BackgroundServiceStartConfig
): void => {
  useEffect(() => {
    Effect.runFork(
      enableBackgroundSessionRecovery(backgroundServiceStartConfig).pipe(
        Effect.catchAll((error) =>
          Effect.logError(
            '[background-service] the servers will not restart after the OS ends the app',
            error
          )
        ),
        Effect.provideService(TauriInvoke, invoke)
      )
    )
  }, [invoke, backgroundServiceStartConfig])
}

/** `children`, once the background session's recovery has been asked for. */
function BackgroundSessionRecovery({
  invoke,
  backgroundServiceStartConfig,
  children,
}: Pick<BaseGateProps, 'invoke' | 'backgroundServiceStartConfig' | 'children'>): JSX.Element {
  useBackgroundSessionRecovery(invoke, backgroundServiceStartConfig)
  return <>{children}</>
}

/**
 * The base's gate, which the app mounts around its whole router: the
 * telemetry consent dialog, then `children`.
 *
 * @remarks
 * **Nothing runs before the user answers.** Until an answer for
 * `WILDFLOWER_HOST_TELEMETRY_CONSENT_COPY` is kept in `storage`, the page is
 * the consent dialog alone: `children` aren't mounted, so the app builds no
 * router or query cache and calls no host command. Once it is answered, the
 * gate enables the background session's recovery with
 * `backgroundServiceStartConfig` and shows `children`. The answer, stored or
 * new, starts telemetry through `useConsentedTelemetryStart` with
 * `telemetry`'s DSN and `app` tag. The base's consent is its own: the web app
 * asks for its own, on its own origin. Host Settings' Telemetry row reads and
 * reopens it, so the base's routes need this gate above them. A
 * `CrashReportingBoundary` reports a crash outside the router's own error
 * boundaries.
 */
function BaseGate({
  invoke,
  backgroundServiceStartConfig,
  telemetry,
  storage,
  children,
}: BaseGateProps): JSX.Element {
  const { startTelemetry } = useConsentedTelemetryStart({
    dsn: telemetry.dsn,
    tags: { app: telemetry.app },
  })
  return (
    <TelemetryConsentGate
      storage={storage}
      copy={WILDFLOWER_HOST_TELEMETRY_CONSENT_COPY}
      onDecided={startTelemetry}
    >
      <CrashReportingBoundary extraContext={{}}>
        <BackgroundSessionRecovery
          invoke={invoke}
          backgroundServiceStartConfig={backgroundServiceStartConfig}
        >
          {children}
        </BackgroundSessionRecovery>
      </CrashReportingBoundary>
    </TelemetryConsentGate>
  )
}

export { BaseGate, type BaseGateProps, type BaseTelemetry }
