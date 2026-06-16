/**
 * `ActiveDeviceUserCodeStore` — the SPA's single piece of state for the
 * non-dismissable device-consent popup: the `user_code` of the
 * currently-pending consent request (or `null` when none is pending).
 *
 * The Rust host is the sole writer. The
 * `bridge:DeviceConsentRequested` handler (in `web-bridge.ts`) calls
 * `setActiveUserCode(...)` whenever a fresh pending head arrives or the
 * head clears. The
 * [`DeviceConsentModalHost`](./device-consent-modal-host.tsx) reads
 * via {@link useActiveDeviceUserCode} and surfaces the modal whenever
 * the value is non-null.
 *
 * No persistence: the host re-delivers the current head on every
 * webview `bridge:__Ready` (page load and reload), so any locally
 * cached value can only ever be stale and would race the host's fresh
 * push. Mirrors the {@link makeEmbeddedAuthTokenStore} rationale.
 */

import { Effect, type Subscribable, SubscriptionRef } from 'effect'

interface ActiveDeviceUserCodeStore {
  /**
   * Live current pending-consent `user_code` (or `null` when no
   * request is pending). Mirrors the `subscribable`-shaped read side
   * the rest of the gatekeeper-react surfaces use.
   */
  readonly subscribable: Subscribable.Subscribable<string | null>
  /**
   * Replace the current head. The web-bridge handler is the only
   * caller — slices and components never write here. Synchronous
   * side-effect, so `subscribable.changes` emits before the call
   * returns.
   */
  readonly setActiveUserCode: (userCode: string | null) => void
}

/**
 * Build a fresh `ActiveDeviceUserCodeStore`. The entry calls this
 * once per page load (web entries pass the resulting setter as a
 * no-op-from-the-host's-perspective writer; only the Tauri host
 * actually pushes consent events).
 */
const makeActiveDeviceUserCodeStore = (): ActiveDeviceUserCodeStore => {
  const ref = Effect.runSync(SubscriptionRef.make<string | null>(null))
  return {
    subscribable: ref,
    setActiveUserCode: (userCode) => Effect.runSync(SubscriptionRef.set(ref, userCode)),
  }
}

export { makeActiveDeviceUserCodeStore }
export type { ActiveDeviceUserCodeStore }
