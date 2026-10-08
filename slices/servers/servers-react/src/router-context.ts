import type { QueryClient } from '@tanstack/react-query'
import { type Context, Effect } from 'effect'
import { TauriInvoke } from 'servers-core'

/**
 * Runs one of `servers-core`'s host commands against the Tauri host,
 * resolving with its decoded answer and rejecting with its
 * `HostCommandError`.
 */
type RunHostCommand = <A, E>(command: Effect.Effect<A, E, TauriInvoke>) => Promise<A>

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
  /** How a route hears the host's events. */
  readonly listenToHostEvent: ListenToHostEvent
}

/** A {@link RunHostCommand} over `invoke`: the app's `@tauri-apps/api/core` `invoke`, or a test's fake. */
const runHostCommandWith =
  (invoke: Context.Tag.Service<TauriInvoke>): RunHostCommand =>
  (command) =>
    Effect.runPromise(Effect.provideService(command, TauriInvoke, invoke))

export { runHostCommandWith }
export type { ListenToHostEvent, RouterContext, RunHostCommand }
