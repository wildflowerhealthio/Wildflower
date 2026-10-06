import { HttpApiError } from '@effect/platform'
import type { Effect, ManagedRuntime } from 'effect'
import { unwrapFiberFailure } from 'kitchen-sink'
import { createContext } from 'react'
import { useContextOrThrow } from 'react-kitchen-sink'
import type { RelayAdminHttpApiClient } from 'relay-core/clients'
import type { AdminKeyStore } from 'relay-core/key-store'

/** What the admin screen's effects run against. */
type RelayAdminServices = RelayAdminHttpApiClient | AdminKeyStore

/**
 * The runtime the app builds once: the admin API client over a signing
 * `HttpClient`, and the key store that client signs from.
 */
type RelayAdminRuntime = ManagedRuntime.ManagedRuntime<RelayAdminServices, never>

/**
 * Run an admin effect for a query or mutation. It rejects with the effect's own
 * failure (a `TunnelNameConflict`, an `Unauthorized`, …), not a `FiberFailure`,
 * so a screen can tell them apart.
 */
type RunRelayAdmin = <A, E>(effect: Effect.Effect<A, E, RelayAdminServices>) => Promise<A>

/** The relay refused the stored key, which is then dropped. */
const isRefusal = (error: unknown): boolean => error instanceof HttpApiError.Unauthorized

interface RelayAdminContextValue {
  readonly run: RunRelayAdmin
  /**
   * The relay answered `401` to the key this screen signed with: the key is
   * wrong, or this device's clock is more than a minute off the relay's. The
   * key has been dropped; signing in again clears this.
   */
  readonly keyRefused: boolean
  readonly setKeyRefused: (refused: boolean) => void
}

const RelayAdminContext = createContext<RelayAdminContextValue | null>(null)

/** The admin screen's runner and sign-in state, from {@link RelayAdminContext}. */
const useRelayAdmin = (): RelayAdminContextValue => useContextOrThrow(RelayAdminContext)

/** {@link RunRelayAdmin} over `runtime`. */
const runWith =
  (runtime: RelayAdminRuntime): RunRelayAdmin =>
  (effect) =>
    runtime.runPromise(effect).catch((caught: unknown) => {
      throw unwrapFiberFailure(caught)
    })

export { isRefusal, RelayAdminContext, runWith, useRelayAdmin }
export type { RelayAdminContextValue, RelayAdminRuntime, RelayAdminServices, RunRelayAdmin }
