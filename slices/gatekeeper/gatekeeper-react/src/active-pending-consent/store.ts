/**
 * `ActivePendingConsentStore` — the SPA's single piece of state for the
 * consent popup: the head of the pending-consent queue (or `null` when
 * nothing is pending). The modal host branches on the head's `kind` to
 * pick the consent form and the fetch that hydrates it.
 *
 * The Rust host is the sole writer. The
 * `bridge:PendingConsentRequested` handler (in `web-bridge.ts`) calls
 * `setActiveHead(...)` whenever a fresh pending head arrives or the
 * head clears. The
 * [`PendingConsentModalHost`](../screens/pending-consent/pending-consent-modal-host.tsx)
 * reads via {@link useActivePendingConsent} and surfaces the modal
 * whenever the value is non-null.
 *
 * No persistence: the host re-delivers the current head on every
 * webview `bridge:__Ready` (page load and reload), so any locally
 * cached value can only ever be stale and would race the host's fresh
 * push. Mirrors the {@link makeEmbeddedAuthStateStore} rationale.
 */

import type { Subscribable } from 'effect'
import type { PendingConsentHead } from 'gatekeeper-core/bridge'
import { makeSubscribableStore } from 'react-kitchen-sink'

interface ActivePendingConsentStore {
  /**
   * Live current pending-consent head (or `null` when no request is
   * pending). Mirrors the `subscribable`-shaped read side the rest of
   * the gatekeeper-react surfaces use.
   */
  readonly subscribable: Subscribable.Subscribable<PendingConsentHead | null>
  /**
   * Replace the current head. The web-bridge handler is the only
   * caller — slices and components never write here. Synchronous Ref
   * write; `subscribable.changes` notifications fire on the next
   * microtask.
   */
  readonly setActiveHead: (head: PendingConsentHead | null) => void
}

/**
 * Build a fresh `ActivePendingConsentStore`. The entry calls this
 * once per page load (web entries pass the resulting setter as a
 * no-op-from-the-host's-perspective writer; only the Tauri host
 * actually pushes consent events).
 */
const makeActivePendingConsentStore = (): ActivePendingConsentStore => {
  const { subscribable, set: setActiveHead } = makeSubscribableStore<PendingConsentHead | null>(
    null
  )
  return { subscribable, setActiveHead }
}

export { makeActivePendingConsentStore }
export type { ActivePendingConsentStore }
