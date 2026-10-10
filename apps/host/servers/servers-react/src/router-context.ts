import type { HttpClient } from '@effect/platform'
import type { QueryClient } from '@tanstack/react-query'
import { TauriInvoke } from '@wildflowerhealthio/servers-core-js'
import { Cause, type Context, Effect, Exit, type Layer } from 'effect'

import type { PendingLaunches } from './pending-launches.ts'

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

/** What every route of the base reads from the router. */
interface RouterContext {
  /** The base's one query cache. */
  readonly queryClient: QueryClient
  /** How a route reaches the host. */
  readonly runHostCommand: RunHostCommand
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

export { runHostCommandWith, runHttpRequestWith }
export type { ListenToHostEvent, RouterContext, RunHostCommand, RunHttpRequest }
