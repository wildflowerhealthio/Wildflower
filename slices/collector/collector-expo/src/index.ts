// Placeholder — the previous `RunSyncModalScreen` consumed
// `BrowserSnifferWebView`'s `postRaw` / `onRawMessage` passthrough
// surface, which this PR retires (the wrapper now exposes a typed
// `BridgeTransport.MessageSender` via ref and routes log/sniffer
// handlers as props). The replacement screen built on typed
// `CollectorBridge` re-emission lands in a follow-up PR. The empty
// type export keeps `collector-expo` a valid module so workspace
// consumers still resolve it.
export type CollectorExpoPlaceholder = never
