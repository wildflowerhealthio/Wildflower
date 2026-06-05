import { Effect, SubscriptionRef, type Subscribable } from 'effect'

/**
 * The active device-consent surface threaded through
 * {@link ActiveDeviceRequestProvider}. Holds the `userCode` of the
 * device-authorization request the embedded SPA should currently prompt
 * the practitioner to approve, or `null` when no prompt is active.
 *
 * @remarks
 * Mirrors `react-kitchen-sink`'s `AuthTokenStore` split, scoped down to
 * what the device popup needs:
 *
 *  - `subscribable` is the *read* side — a
 *    `Subscribable.Subscribable<string | null>`, the narrowest shape the
 *    React modal host needs to observe head changes via `.changes` and
 *    read the current value via `.get`.
 *  - `setActiveUserCode` is the *write* side: the host's
 *    `DeviceAuthorizationActiveChanged` bridge handler is the sole
 *    writer. It's passed straight into `makeGatekeeperWebHandlers` at
 *    entrypoint wiring time (not read back through context), so unlike
 *    the auth-token store there's no setter hook.
 */
interface ActiveDeviceRequestStore {
  /**
   * Live `userCode` of the device-authorization request to prompt for,
   * or `null` when none is active. The React host observes
   * `subscribable.changes` for re-render and reads `subscribable.get`
   * for the current value.
   */
  readonly subscribable: Subscribable.Subscribable<string | null>
  /**
   * Set the active device-consent `userCode`, or clear with `null`.
   * Synchronous — `subscribable.changes` emits the new value before
   * this returns.
   */
  readonly setActiveUserCode: (userCode: string | null) => void
}

/**
 * Build an {@link ActiveDeviceRequestStore}: a
 * `SubscriptionRef<string | null>` seeded with `null`, no persistence
 * and no cross-tab listener. The device popup is embedded-only, so the
 * sole writer is the host's `DeviceAuthorizationActiveChanged` handler;
 * standalone-web entries construct one too but it simply stays `null`
 * (no host pushes the message), so the modal never appears.
 *
 * Call once per page load in the shared `app-root` before `renderApp`,
 * alongside the auth-token store.
 */
const makeActiveDeviceRequestStore = (): ActiveDeviceRequestStore => {
  const ref = Effect.runSync(SubscriptionRef.make<string | null>(null))
  return {
    subscribable: ref,
    setActiveUserCode: (userCode) => Effect.runSync(SubscriptionRef.set(ref, userCode)),
  }
}

export { makeActiveDeviceRequestStore }
export type { ActiveDeviceRequestStore }
