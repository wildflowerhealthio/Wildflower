import { WILDFLOWER_HOST_TELEMETRY_CONSENT_COPY } from '@wildflowerhealthio/branding-core'
import {
  denyNotifiedConsent,
  enableBackgroundSessionRecovery,
  type BackgroundServiceStartConfig,
  NotificationAction,
  openNotifiedConsent,
  TauriInvoke,
} from '@wildflowerhealthio/servers-core-js'
import type { ConsentStorage } from '@wildflowerhealthio/telemetry-core'
import {
  CrashReportingBoundary,
  TelemetryConsentGate,
  useConsentedTelemetryStart,
} from '@wildflowerhealthio/telemetry-react'
import { type Context, Effect, Either, Match, Schema } from 'effect'
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
 * How the base hears a tap on one of the app's notifications, on its text or
 * on an action: the notification plugin's `actionPerformed`, through
 * `addPluginListener` from `@tauri-apps/api/core`. `handler` gets each tap's
 * payload, which the base decodes. Resolves with the function that stops
 * listening; rejects where the platform reports no taps, as a desktop's
 * doesn't.
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
 * The host command that does what `action` asks for, on the consent its
 * notification named, logging a refusal; nothing for an action that asks for
 * nothing, as a dismissal.
 */
const actOnConsentNotification = (
  action: NotificationAction.Type
): Effect.Effect<void, never, TauriInvoke> => {
  const notificationId = action.notification.id
  return Match.value(NotificationAction.intentOf(action)).pipe(
    Match.when('open', () =>
      openNotifiedConsent({ notificationId }).pipe(
        Effect.catchAll((error) =>
          Effect.logWarning("[servers] the tapped notification's consent didn't open", error)
        )
      )
    ),
    Match.when('deny', () =>
      denyNotifiedConsent({ notificationId }).pipe(
        Effect.catchAll((error) =>
          Effect.logWarning("[servers] the notification's consent wasn't denied", error)
        )
      )
    ),
    Match.when('nothing', () =>
      Effect.logDebug(`[servers] notification action ${action.actionId} asks for nothing`)
    ),
    Match.exhaustive
  )
}

/**
 * While mounted, act on each tapped consent notification through the host:
 * a tap on its text or its Open opens the consent it announced at its page
 * (`openNotifiedConsent`), and its Deny denies it (`denyNotifiedConsent`), on
 * a phone, from anywhere in the app. The host acts once its server can, and
 * logs a request decided meanwhile; an action the host refuses is logged
 * here. A platform that reports no taps is logged too.
 */
const useNotificationActions = (
  invoke: Context.Tag.Service<TauriInvoke>,
  listenToNotificationTaps: ListenToNotificationTaps
): void => {
  useEffect(() => {
    const actOnTapped = (tap: unknown): void => {
      Either.match(Schema.decodeUnknownEither(NotificationAction.Schema)(tap), {
        onLeft: (error) => {
          Effect.runSync(Effect.logWarning("[servers] a notification tap didn't decode", error))
        },
        onRight: (action) => {
          Effect.runFork(
            actOnConsentNotification(action).pipe(Effect.provideService(TauriInvoke, invoke))
          )
        },
      })
    }
    let unmounted = false
    let stopListening: (() => void) | undefined
    listenToNotificationTaps(actOnTapped).then(
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
 * acting on each tapped consent notification.
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
  useNotificationActions(invoke, listenToNotificationTaps)
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
 * `backgroundServiceStartConfig`, opens or denies the consent of each consent
 * notification tapped, as its tap asks (through `listenToNotificationTaps`),
 * and shows
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
