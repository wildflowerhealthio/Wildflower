/**
 * Re-export shim: the `WebViewSource` schemas moved down to
 * `browser-sniffer-core` (they describe what the sniffer webview loads, and
 * the sniffer slice's `/sniffer` HttpApi definition needs them — the reverse
 * import would break slice layering). Everything in this slice keeps
 * importing them through `collector-fundamentals/model`'s `WebViewSource`
 * namespace, unchanged.
 */
export * from 'browser-sniffer-core/web-view-source'
