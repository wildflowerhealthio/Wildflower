import type { BareSenderService } from 'effect-messaging-core'
import { createContext, type RefObject } from 'react'

interface WebviewBareSenderRefContextValue {
  /**
   * Ref to the host shell WebView's bare sender. Filled by the
   * `<EffectMessagingWebView>` instance when it mounts. Used today by
   * `_layout.tsx`'s `postRawMessage` callback to forward sniffer-wire
   * payloads from the collector modal back into the SPA without a
   * decode/re-encode round trip.
   *
   * The next pass (commit 4) replaces raw forwarding with typed
   * `CollectorBridge` re-emission, after which this context can be
   * deleted entirely — the ref then lives inside the transport
   * builder's own scope.
   */
  readonly webviewBareSenderRef: RefObject<BareSenderService | null>
}

const WebviewBareSenderRefContext = createContext<WebviewBareSenderRefContextValue | null>(null)

export { WebviewBareSenderRefContext }
export type { WebviewBareSenderRefContextValue }
