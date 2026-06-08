import {
  CancelSnifferRequestMessage,
  CancelledMessage,
  ClickMessage,
  PageLoadedMessage,
  RequestErrorMessage,
  ResponseDataMessage,
  ResponseFinishedMessage,
  ResponseStartMessage,
} from 'browser-sniffer-core'
import { Schema } from 'effect'
import { Bridge } from 'effect-messaging-core'

import { AnySchema as WebViewSourceSchema } from './model/web-view-source.ts'

/**
 * Web → Host: the collector SPA asks the host to open a sniffer-enabled
 * WebView for the given `source`. The host opens a screen with
 * `<BrowserSnifferWebView>` and forwards the resulting sniffer events
 * back through this same bridge's Host→Web channel.
 *
 * The `source` field reuses the slice's `WebViewSource.AnySchema` so
 * the bridge wire-shape and the host-side `WebViewSource.Any` type
 * share one definition. The schema's `Uri` variant is `https://`-only
 * (see `web-view-source.ts`) — malformed messages fail to decode at
 * the bridge boundary.
 *
 * `linkedSpan` is the optional OpenTelemetry span context of the trace
 * active on the SPA when it asked for the sniffer. The host threads it
 * to `<BrowserSnifferWebView>`, which adds it as a span *link* on every
 * root span it opens (the initial-load span and each per-page span), so
 * the otherwise-independent sniffer traces point back at the collector's
 * sync trace. Omitted when no span was in scope at send time.
 */
const RequestSniffableWebView = Schema.parseJson(
  Schema.TaggedStruct('RequestSniffableWebView', {
    source: WebViewSourceSchema,
    linkedSpan: Schema.optional(Schema.Struct({ traceId: Schema.String, spanId: Schema.String })),
  })
)

/**
 * Web → Host: the collector SPA decided the active sync is done (either
 * the expected resources have been collected or a heuristic timed out
 * after PageLoaded). The host closes the sniffer modal; the
 * collector-react SPA underneath is still mounted and shows the
 * just-imported data.
 */
const SniffingComplete = Schema.parseJson(Schema.TaggedStruct('SniffingComplete', {}))

/**
 * Web → Host: the collector SPA's handler decided the active sync's
 * next step is to mount a fresh page in the BrowserSnifferWebView.
 * `source` reuses the slice's `WebViewSource.AnySchema` so the same
 * tagged union the host uses for the initial `firstPage` also covers
 * subsequent navigations — `{ _tag: 'Uri', uri: 'https://…' }` for a
 * remote page, `{ _tag: 'Html', html: '…' }` for an inline scaffold.
 * The page reload re-injects the sniffer (idempotently keyed by
 * `Symbol.for('browser-sniffer:state')`) and a new `PageLoaded`
 * eventually flows back through Host→Web.
 */
const OpenMessage = Schema.parseJson(Schema.TaggedStruct('Open', { source: WebViewSourceSchema }))

type CollectorBridge = Bridge.Bridge<
  'Collector',
  {
    ResponseStart: typeof ResponseStartMessage
    ResponseData: typeof ResponseDataMessage
    ResponseFinished: typeof ResponseFinishedMessage
    RequestError: typeof RequestErrorMessage
    Cancelled: typeof CancelledMessage
    PageLoaded: typeof PageLoadedMessage
  },
  {
    RequestSniffableWebView: typeof RequestSniffableWebView
    CancelSnifferRequest: typeof CancelSnifferRequestMessage
    SniffingComplete: typeof SniffingComplete
    Open: typeof OpenMessage
    Click: typeof ClickMessage
  }
>

/**
 * Slice-level bridge between the embedded collector SPA and the Expo
 * host. Web→Host carries control signals (`RequestSniffableWebView`,
 * `CancelSnifferRequest`, `SniffingComplete`) and script-driven
 * navigation steps (`Open`, `Click`); Host→Web carries the
 * sniffer-event subset collector parses plus the `PageLoaded`
 * notification that drives the step timer.
 *
 * `Click` is the same `ClickMessage` schema `BrowserSnifferBridge`
 * declares for its Host→Web side, so the collector-expo runtime
 * forwards the decoded payload through both bridges without
 * re-encoding. The six sniffer events imported from
 * `browser-sniffer-core` keep wire schemas in lockstep with
 * `BrowserSnifferBridge` for the same reason. `Cancelled` is the
 * terminal acknowledgement for a mid-stream `CancelSnifferRequest`;
 * the handler uses it to release the in-progress slot and notify the
 * consumer via `onResult` with a `Left(SnifferCancelled)`.
 */
const CollectorBridge: CollectorBridge = Bridge.make({
  name: 'Collector',
  hostToWeb: [
    ['ResponseStart', ResponseStartMessage],
    ['ResponseData', ResponseDataMessage],
    ['ResponseFinished', ResponseFinishedMessage],
    ['RequestError', RequestErrorMessage],
    ['Cancelled', CancelledMessage],
    ['PageLoaded', PageLoadedMessage],
  ] as const,
  webToHost: [
    ['RequestSniffableWebView', RequestSniffableWebView],
    ['CancelSnifferRequest', CancelSnifferRequestMessage],
    ['SniffingComplete', SniffingComplete],
    ['Open', OpenMessage],
    ['Click', ClickMessage],
  ] as const,
})

export { CollectorBridge, OpenMessage, RequestSniffableWebView, SniffingComplete }
