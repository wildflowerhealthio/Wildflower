/**
 * Central catalog of OpenTelemetry span names and attribute keys for the
 * browser-sniffer host adapter. Kept in one file — even though the spans
 * fire from the platform adapter (`browser-sniffer-expo`), not this pure
 * core — so the naming philosophy stays coherent in a single place, the
 * same way `collector-fundamentals/telemetry` centralises the collector's.
 *
 * Shape: `FeatureArea.Task.Span.{ Name, Attributes }`, with attribute
 * keys that recur across a feature lifted to a feature-level `Attributes`
 * namespace so they are defined once. Attribute values prefer
 * OpenTelemetry semantic conventions where one exists (`url.full`);
 * everything browser-sniffer-specific is namespaced under
 * `browser_sniffer.*`.
 */

/**
 * The host driving a sniffed page through `BrowserSnifferBridge`: the
 * page's readiness handshake and each host→web control message the
 * adapter dispatches against the page.
 */
const Bridge = {
  /** Attribute keys shared across the bridge-driving spans. */
  Attributes: {
    /**
     * `_tag` of the host→web control message (`Click` /
     * `CancelSnifferRequest`). Lifted to the feature level because both
     * the dispatch span and any future per-tag span key off it.
     */
    MessageTag: 'browser_sniffer.message.tag',
  },
  /**
   * The page's `__Ready` handshake landing on the host — the moment the
   * injected sniffer is installed and the typed sender is captured.
   * Spanning it marks the boundary after which host→web sends stop
   * dropping pre-mount.
   */
  PageReady: {
    Span: { Name: 'browser_sniffer.bridge.page_ready' },
  },
  /**
   * Dispatching one host→web control message (`Click` /
   * `CancelSnifferRequest`) to the sniffed page. Mirrors the collector's
   * `Sniffing.Dispatch` span — the timed act of pushing an instruction
   * across the bridge.
   */
  Dispatch: {
    Span: { Name: 'browser_sniffer.bridge.dispatch' },
  },
} as const

export { Bridge }
