import { Schema } from 'effect'

/**
 * Wire schemas for the events the injected browser-sniffer posts to its
 * host and the control messages the host sends back. Each schema is a
 * tagged struct wrapped in `Schema.parseJson` so it round-trips through
 * `window.postMessage`'s string-only wire; the host decodes them via
 * `BrowserSnifferBridge`'s `BridgeTransport` and dispatches by `_tag`.
 *
 * Why JSON-flat (not nested envelopes): the sniffer is injected into
 * third-party pages and must use raw `window.ReactNativeWebView.postMessage`
 * without any module-loading. A flat tagged-struct wire format keeps the
 * sniffer trivial to author while still typed end-to-end at the host.
 *
 * The sniffer additionally posts `{"_tag":"__Ready"}` as its first
 * message (handled internally by `BridgeTransport`'s send-gating
 * Deferred). It is *not* declared here because it's a transport-level
 * control message, not a domain event consumers should observe.
 *
 * The `*Body` schemas (the inner `TaggedStruct`s before the
 * `parseJson` wrap) are exported separately so the injected sniffer
 * can type-import the JSON-stringifiable shape. The injected file
 * cannot import runtime schemas (everything resolves to nothing
 * inside the stringified function body), but type-only imports
 * survive the `toString()` path.
 *
 * Why `data` is a plain `Schema.String` (base64-encoded by convention)
 * and not `Schema.Uint8ArrayFromBase64`: the `BridgeTransport` runs
 * each inbound schema through `Schema.typeSchema`, which strips
 * transforms. A `Uint8ArrayFromBase64` field would leave the bridge
 * expecting an already-decoded `Uint8Array` after `JSON.parse`, which
 * the wire (a base64 string) cannot satisfy. Keeping `data: string`
 * lets the bridge decode round-trip cleanly; consumers that need
 * bytes apply `Schema.decode(Schema.Uint8ArrayFromBase64)` (or
 * `atob`) at their own boundary.
 */

const LogMessageBody = Schema.TaggedStruct('Log', {
  log: Schema.String,
})
const LogMessage = Schema.parseJson(LogMessageBody)

const ResponseStartMessageBody = Schema.TaggedStruct('ResponseStart', {
  id: Schema.String,
  url: Schema.String,
  status: Schema.Number,
  statusText: Schema.String,
  headers: Schema.Record({ key: Schema.String, value: Schema.String }),
})
const ResponseStartMessage = Schema.parseJson(ResponseStartMessageBody)

const ResponseDataMessageBody = Schema.TaggedStruct('ResponseData', {
  id: Schema.String,
  /** Base64-encoded response bytes. See file header for why this is `String` and not `Uint8ArrayFromBase64`. */
  data: Schema.String,
})
const ResponseDataMessage = Schema.parseJson(ResponseDataMessageBody)

const ResponseFinishedMessageBody = Schema.TaggedStruct('ResponseFinished', {
  id: Schema.String,
})
const ResponseFinishedMessage = Schema.parseJson(ResponseFinishedMessageBody)

const RequestErrorMessageBody = Schema.TaggedStruct('RequestError', {
  id: Schema.String,
  url: Schema.String,
  message: Schema.String,
})
const RequestErrorMessage = Schema.parseJson(RequestErrorMessageBody)

const PageLoadedMessageBody = Schema.TaggedStruct('PageLoaded', {
  url: Schema.String,
  content: Schema.String,
})
const PageLoadedMessage = Schema.parseJson(PageLoadedMessageBody)

const CancelSnifferRequestMessageBody = Schema.TaggedStruct('CancelSnifferRequest', {
  id: Schema.String,
})
const CancelSnifferRequestMessage = Schema.parseJson(CancelSnifferRequestMessageBody)

export {
  LogMessage,
  LogMessageBody,
  ResponseStartMessage,
  ResponseStartMessageBody,
  ResponseDataMessage,
  ResponseDataMessageBody,
  ResponseFinishedMessage,
  ResponseFinishedMessageBody,
  RequestErrorMessage,
  RequestErrorMessageBody,
  PageLoadedMessage,
  PageLoadedMessageBody,
  CancelSnifferRequestMessage,
  CancelSnifferRequestMessageBody,
}
