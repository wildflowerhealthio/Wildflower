import { FetchHttpClient, type HttpClient } from '@effect/platform'
import { QueryCache, QueryClient } from '@tanstack/react-query'
import { type HostPlatform, TauriInvoke } from '@wildflowerhealthio/servers-core-js'
import { Sentry } from '@wildflowerhealthio/telemetry-web'
import { Cause, type Context, Effect, Exit, type Layer } from 'effect'

import { makeEmptyPendingLaunches, type PendingLaunches } from './pending-launches.ts'

/**
 * Runs one of `servers-core-js`'s host commands against the Tauri host,
 * resolving with its decoded answer and rejecting with its
 * `HostCommandError`.
 */
type RunHostCommand = <A, E>(command: Effect.Effect<A, E, TauriInvoke>) => Promise<A>

/**
 * Runs an HTTP request the base makes from its webview itself, such as a
 * server's `/health`, resolving with its result and rejecting with its
 * error.
 */
type RunHttpRequest = <A, E>(request: Effect.Effect<A, E, HttpClient.HttpClient>) => Promise<A>

/**
 * How the base listens to a host event: `listen` from
 * `@tauri-apps/api/event`, read only for each event's payload, which the
 * listener decodes. Resolves with the function that stops listening.
 */
type ListenToHostEvent = (
  event: string,
  handler: (event: { readonly payload: unknown }) => void
) => Promise<() => void>

/**
 * What every route of the base reads from the router: the context the app's
 * router gives its routes includes this.
 */
interface RouterContext {
  /** The base's one query cache. */
  readonly queryClient: QueryClient
  /** How a route reaches the host. */
  readonly runHostCommand: RunHostCommand
  /** The kind of device the host runs on. */
  readonly platform: HostPlatform.Type
  /** How a route makes an HTTP request from the webview. */
  readonly runHttpRequest: RunHttpRequest
  /** How a route hears the host's events. */
  readonly listenToHostEvent: ListenToHostEvent
  /**
   * The launcher the host gives a new server, from the app's
   * `tauri-shared-config.json`, which the host reads too.
   */
  readonly defaultLauncherUrl: string
  /**
   * The Authorization app the host gives a new server, from the app's
   * `tauri-shared-config.json`, which the host reads too.
   */
  readonly defaultAuthorizationUrl: string
  /**
   * The servers' pending start-and-launches, which every Launch of a server
   * reads, so a wait outlives the screen it began on.
   */
  readonly pendingLaunches: PendingLaunches
}

/**
 * Run `effect`, resolving with its value and rejecting with the error it
 * failed with, or its defect, rather than `Effect.runPromise`'s
 * `FiberFailure` wrapping either, so a caller can branch on the error.
 */
const runRejectingWithError = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromiseExit(effect).then((exit) =>
    Exit.isSuccess(exit) ? exit.value : Promise.reject(Cause.squash(exit.cause))
  )

/** A {@link RunHostCommand} over `invoke`: the app's `@tauri-apps/api/core` `invoke`, or a test's fake. */
const runHostCommandWith =
  (invoke: Context.Tag.Service<TauriInvoke>): RunHostCommand =>
  (command) =>
    runRejectingWithError(Effect.provideService(command, TauriInvoke, invoke))

/**
 * A {@link RunHttpRequest} over `layer`: `@effect/platform`'s
 * `FetchHttpClient.layer`, or a test's stub client.
 */
const runHttpRequestWith =
  (layer: Layer.Layer<HttpClient.HttpClient>): RunHttpRequest =>
  (request) =>
    runRejectingWithError(Effect.provide(request, layer))

/** What {@link make} builds the base's {@link RouterContext} over. */
interface RouterContextInputs {
  /** How the base calls the host: `invoke` from `@tauri-apps/api/core`. */
  readonly invoke: Context.Tag.Service<TauriInvoke>
  /**
   * The kind of device the host runs on, from the OS the app reads once:
   * `platform()` from `@tauri-apps/plugin-os`.
   */
  readonly platform: HostPlatform.Type
  /** How the base hears the host's events: `listen` from `@tauri-apps/api/event`. */
  readonly listen: ListenToHostEvent
  /**
   * The launcher the host gives a new server, from the app's
   * `tauri-shared-config.json`, which the host reads too. The server page
   * offers it as Reset to default.
   */
  readonly defaultLauncherUrl: string
  /**
   * The Authorization app the host gives a new server, from the app's
   * `tauri-shared-config.json`, which the host reads too. The server page
   * offers it as Reset to default.
   */
  readonly defaultAuthorizationUrl: string
  /**
   * The client the base's own HTTP requests go through, such as a server's
   * `/health`. Defaults to the webview's `fetch`; tests pass a stub.
   */
  readonly httpClient?: Layer.Layer<HttpClient.HttpClient>
}

/**
 * The base's {@link RouterContext}, with a query cache of its own: built once,
 * by the app that composes the base's routes into its router, which provides
 * the same `queryClient` to its `QueryClientProvider`.
 *
 * @remarks
 * Every failed host read is reported; `captureException` does nothing until a
 * yes starts Sentry. A host command is a local call: one that failed fails the
 * same way again, so it shows its error at once; and it needs no network, so
 * it runs while the device is offline.
 */
const make = ({
  invoke,
  platform,
  listen,
  defaultLauncherUrl,
  defaultAuthorizationUrl,
  httpClient = FetchHttpClient.layer,
}: RouterContextInputs): RouterContext => ({
  queryClient: new QueryClient({
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
  platform,
  runHttpRequest: runHttpRequestWith(httpClient),
  listenToHostEvent: listen,
  defaultLauncherUrl,
  defaultAuthorizationUrl,
  pendingLaunches: makeEmptyPendingLaunches(),
})

export { make, runHostCommandWith, runHttpRequestWith }
export type {
  ListenToHostEvent,
  RouterContext,
  RouterContextInputs,
  RunHostCommand,
  RunHttpRequest,
}
