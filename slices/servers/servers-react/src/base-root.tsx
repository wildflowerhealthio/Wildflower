import { FetchHttpClient, type HttpClient } from '@effect/platform'
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createBrowserHistory, RouterProvider, type RouterHistory } from '@tanstack/react-router'
import { WILDFLOWER_HOST_TELEMETRY_CONSENT_COPY } from 'branding-core'
import { type Context, Effect, type Layer } from 'effect'
import { useEffect, useState, type JSX } from 'react'
import {
  enableBackgroundSessionRecovery,
  type BackgroundServiceStartConfig,
  TauriInvoke,
} from 'servers-core'
import type { ConsentStorage } from 'telemetry-core'
import {
  CrashReportingBoundary,
  TelemetryConsentGate,
  useConsentedTelemetryStart,
} from 'telemetry-react'
import { Sentry } from 'telemetry-web'

import { makePendingLaunches } from './pending-launches.ts'
import { type ListenToHostEvent, runHostCommandWith, runHttpRequestWith } from './router-context.ts'
import { buildBaseRouter } from './router.ts'

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

/** Props for {@link BaseRoot}. */
interface BaseRootProps {
  /** How the base calls the host: `invoke` from `@tauri-apps/api/core`. */
  readonly invoke: Context.Tag.Service<TauriInvoke>
  /** How the base hears the host's events: `listen` from `@tauri-apps/api/event`. */
  readonly listen: ListenToHostEvent
  /**
   * How the host's unit runner starts its background session, from the app's
   * `tauri-shared-config.json`, which the host reads too.
   */
  readonly backgroundServiceStartConfig: BackgroundServiceStartConfig
  /**
   * The launcher the host gives a new server, from the app's
   * `tauri-shared-config.json`, which the host reads too. The server page
   * offers it as Reset to default.
   */
  readonly defaultLauncherUrl: string
  /** Where the base's telemetry goes once the user consents to it. */
  readonly telemetry: BaseTelemetry
  /**
   * The client the base's own HTTP requests go through, such as a server's
   * `/health`. Defaults to the webview's `fetch`; tests pass a stub.
   */
  readonly httpClient?: Layer.Layer<HttpClient.HttpClient>
  /** The router's history. Defaults to the webview's own; tests pass a memory one. */
  readonly history?: RouterHistory
  /** Where the consent answer is kept. Defaults to the webview's `localStorage`. */
  readonly storage?: ConsentStorage
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

/** The base's router and its query cache, built once. */
function BaseRouter({
  invoke,
  listen,
  backgroundServiceStartConfig,
  defaultLauncherUrl,
  httpClient,
  history,
}: Pick<
  BaseRootProps,
  | 'invoke'
  | 'listen'
  | 'backgroundServiceStartConfig'
  | 'defaultLauncherUrl'
  | 'httpClient'
  | 'history'
>): JSX.Element {
  useBackgroundSessionRecovery(invoke, backgroundServiceStartConfig)
  const [router] = useState(() =>
    buildBaseRouter({
      history: history ?? createBrowserHistory(),
      context: {
        // Every failed host read is reported; `captureException` does nothing
        // until a yes starts Sentry.
        queryClient: new QueryClient({
          // A host command is a local call: one that failed fails the same way
          // again, so it shows its error at once; and it needs no network, so
          // it runs while the device is offline.
          defaultOptions: {
            queries: { retry: false, networkMode: 'always' },
            mutations: { networkMode: 'always' },
          },
          queryCache: new QueryCache({
            onError: (queryError) => {
              Sentry.captureException(queryError, { tags: { source: 'query' } })
            },
          }),
        }),
        runHostCommand: runHostCommandWith(invoke),
        runHttpRequest: runHttpRequestWith(httpClient ?? FetchHttpClient.layer),
        listenToHostEvent: listen,
        defaultLauncherUrl,
        pendingLaunches: makePendingLaunches(),
      },
    })
  )
  return (
    <QueryClientProvider client={router.options.context.queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
}

/**
 * The base app the Tauri host's webview mounts: its own telemetry consent
 * gate, then its screens.
 *
 * @remarks
 * **Nothing runs before the user answers.** Until an answer for
 * `WILDFLOWER_HOST_TELEMETRY_CONSENT_COPY` is kept in `storage`, the page is
 * the consent dialog alone: no router or query cache exists and no host
 * command is called. Once it is answered, the base enables the background
 * session's recovery with `backgroundServiceStartConfig` and shows its
 * screens. The answer, stored or new, starts telemetry through
 * `useConsentedTelemetryStart` with `telemetry`'s DSN and `app` tag. The
 * base's consent is its own: the web app asks for its own, on its own origin.
 * A `CrashReportingBoundary` reports a screen that crashes.
 */
function BaseRoot({
  invoke,
  listen,
  backgroundServiceStartConfig,
  defaultLauncherUrl,
  telemetry,
  httpClient,
  history,
  storage,
}: BaseRootProps): JSX.Element {
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
        <BaseRouter
          invoke={invoke}
          listen={listen}
          backgroundServiceStartConfig={backgroundServiceStartConfig}
          defaultLauncherUrl={defaultLauncherUrl}
          httpClient={httpClient}
          history={history}
        />
      </CrashReportingBoundary>
    </TelemetryConsentGate>
  )
}

export { BaseRoot, type BaseRootProps, type BaseTelemetry }
