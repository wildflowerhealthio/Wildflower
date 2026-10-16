import { WILDFLOWER_HOST_TELEMETRY_CONSENT_COPY } from '@wildflowerhealthio/branding-core'
import {
  enableBackgroundSessionRecovery,
  type BackgroundServiceStartConfig,
  openNotifiedConsent,
  TauriInvoke,
} from '@wildflowerhealthio/servers-core-js'
import type { ConsentStorage } from '@wildflowerhealthio/telemetry-core'
import {
  CrashReportingBoundary,
  TelemetryConsentGate,
  useConsentedTelemetryStart,
} from '@wildflowerhealthio/telemetry-react'
import { type Context, Effect, Either, Schema } from 'effect'
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

/**
 * How the base hears a tap on one of the app's notifications: the
 * notification plugin's `actionPerformed`, through `addPluginListener` from
 * `@tauri-apps/api/core`. `handler` gets each tap's payload, which the base
 * decodes. Resolves with the function that stops listening; rejects where
 * the platform reports no taps, as a desktop's doesn't.
 */
type ListenToNotificationTaps = (handler: (tap: unknown) => void) => Promise<() => void>

/** Props for {@link BaseGate}. */
interface BaseGateProps {
  /** How the base calls the host: `invoke` from `@tauri-apps/api/core`. */
  readonly invoke: Context.Tag.Service<TauriInvoke>
  /**
   * How the host's unit runner starts its background session, from the app's
   * `tauri-shared-config.json`, which the host reads too.
   */
  readonly backgroundServiceStartConfig: BackgroundServiceStartConfig
  /** How the base hears a tap on one of the app's notifications. */
  readonly listenToNotificationTaps: ListenToNotificationTaps
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

/**
 * A tap on a notification, as the plugin reports it: the id the notification
 * was posted under, the one thing about it every platform reports.
 */
const NotificationTapSchema = Schema.Struct({
  notification: Schema.Struct({ id: Schema.Number }),
})

/**
 * While mounted, open the consent each tapped consent notification announced,
 * at its page, through the host (`openNotifiedConsent`): on a phone, from
 * anywhere in the app. The host opens it once its server can, and logs a
 * request decided meanwhile; a tap the host refuses is logged here. A
 * platform that reports no taps is logged too.
 */
const useNotifiedConsentOpening = (
  invoke: Context.Tag.Service<TauriInvoke>,
  listenToNotificationTaps: ListenToNotificationTaps
): void => {
  useEffect(() => {
    const openTapped = (tap: unknown): void => {
      Either.match(Schema.decodeUnknownEither(NotificationTapSchema)(tap), {
        onLeft: (error) => {
          Effect.runSync(Effect.logWarning("[servers] a notification tap didn't decode", error))
        },
        onRight: ({ notification }) => {
          Effect.runFork(
            openNotifiedConsent({ notificationId: notification.id }).pipe(
              Effect.catchAll((error) =>
                Effect.logWarning("[servers] the tapped notification's consent didn't open", error)
              ),
              Effect.provideService(TauriInvoke, invoke)
            )
          )
        },
      })
    }
    let unmounted = false
    let stopListening: (() => void) | undefined
    listenToNotificationTaps(openTapped).then(
      (stop) => {
        if (unmounted) {
          stop()
          return
        }
        stopListening = stop
      },
      (error: unknown) => {
        Effect.runSync(
          Effect.logDebug('[servers] this platform reports no notification taps', error)
        )
      }
    )
    return () => {
      unmounted = true
      stopListening?.()
    }
  }, [invoke, listenToNotificationTaps])
}

/**
 * `children`, once the background session's recovery has been asked for,
 * opening the consent of each tapped consent notification.
 */
function BackgroundSessionRecovery({
  invoke,
  backgroundServiceStartConfig,
  listenToNotificationTaps,
  children,
}: Pick<
  BaseGateProps,
  'invoke' | 'backgroundServiceStartConfig' | 'listenToNotificationTaps' | 'children'
>): JSX.Element {
  useBackgroundSessionRecovery(invoke, backgroundServiceStartConfig)
  useNotifiedConsentOpening(invoke, listenToNotificationTaps)
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
 * `backgroundServiceStartConfig`, opens the consent of each consent
 * notification tapped (through `listenToNotificationTaps`), and shows
 * `children`. The answer, stored or
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
  listenToNotificationTaps,
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
          listenToNotificationTaps={listenToNotificationTaps}
        >
          {children}
        </BackgroundSessionRecovery>
      </CrashReportingBoundary>
    </TelemetryConsentGate>
  )
}

export { BaseGate, type BaseGateProps, type BaseTelemetry, type ListenToNotificationTaps }
