import {
  CancelSnifferRequestMessage,
  CancelledMessage,
  PageActionMessage,
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
 * WebView for the given `source`. The Tauri host
 * (`browser-sniffer-tauri-rust`) opens a sniffer `WebviewWindow` and
 * forwards the resulting sniffer events back through this same bridge's
 * Host→Web channel.
 *
 * The `source` field reuses the slice's `WebViewSource.AnySchema` so
 * the bridge wire-shape and the host-side `WebViewSource.Any` type
 * share one definition. The schema's `Uri` variant is `http(s)://`-only
 * (see `web-view-source.ts`) — non-http(s) schemes (`file:`,
 * `javascript:`, …) fail to decode at the bridge boundary.
 *
 * `linkedSpan` is the optional OpenTelemetry span context of the trace
 * active on the SPA when it asked for the sniffer. The host threads it
 * into the sniffer webview, which adds it as a span *link* on every
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
 * next step is to navigate the sniffer webview to a fresh page.
 * `source` reuses the slice's `WebViewSource.AnySchema` so the same
 * tagged union the host uses for the initial `firstPage` also covers
 * subsequent navigations — `{ _tag: 'Uri', uri: 'https://…' }` for a
 * remote page, `{ _tag: 'Html', html: '…' }` for an inline scaffold.
 * The page reload re-injects the sniffer (idempotently keyed by
 * `Symbol.for('browser-sniffer:state')`) and a new `PageLoaded`
 * eventually flows back through Host→Web.
 */
const OpenMessage = Schema.parseJson(Schema.TaggedStruct('Open', { source: WebViewSourceSchema }))

/**
 * Web → Host: the collector SPA's automatic-navigation machine reached a
 * step and asks the host to display that step's manually-authored `name` in
 * the built-in sniffer browser's native chrome, so the user can see what the
 * automation is doing ("Entering email", "Waiting for prescriptions to
 * load"). The Tauri host (`browser-sniffer-tauri-rust`) writes `name` to the
 * sniffer webview's chrome **subtitle** via the native-webview plugin's
 * `patch_window_text` — replacing the static "Collecting Automatically" seed
 * as the run progresses. It is a pure chrome-label update: no page navigation,
 * and it is never forwarded into the sniffed page.
 */
const SetSnifferStatus = Schema.parseJson(
  Schema.TaggedStruct('SetSnifferStatus', { name: Schema.String })
)

/**
 * Web → Host: the collector SPA asks the host to (re-)present the existing
 * sniffer webview — `browser-sniffer-tauri-rust` maps it to
 * `native_webview().show(SNIFFER_WEBVIEW_ID)`. Unlike `Open` it does **not**
 * navigate: it re-presents a hidden-but-alive webview without reloading the page,
 * and no-ops if none exists. The automatic-navigation machine dispatches it for
 * an `EnsureWindowVisible` step so a plan can ask for the window to be on screen
 * before an `AwaitUserDismiss` hold (e.g. after the user dismissed it earlier in
 * the run, leaving it alive but hidden).
 */
const EnsureSnifferVisible = Schema.parseJson(Schema.TaggedStruct('EnsureSnifferVisible', {}))

/**
 * Host → Web: the Tauri host observed that the user dismissed (closed) the
 * sniffer webview — on desktop, clicking the window's X, which the
 * native-webview plugin turns into a `Hidden` lifecycle event (the webview stays
 * alive). The host synthesizes this control message from that event; it does not
 * originate from the injected page, so it lives on `CollectorBridge` only (not
 * `BrowserSnifferBridge`) and is not part of the page→host data-plane allowlist.
 *
 * The collector-react SPA forwards it into the automatic-navigation machine,
 * which consumes an `AwaitUserDismiss` hold it is parked on; in any other state
 * it is ignored.
 */
const UserDismissed = Schema.parseJson(Schema.TaggedStruct('UserDismissed', {}))

type CollectorBridge = Bridge.Bridge<
  'Collector',
  {
    ResponseStart: typeof ResponseStartMessage
    ResponseData: typeof ResponseDataMessage
    ResponseFinished: typeof ResponseFinishedMessage
    RequestError: typeof RequestErrorMessage
    Cancelled: typeof CancelledMessage
    PageLoaded: typeof PageLoadedMessage
    UserDismissed: typeof UserDismissed
  },
  {
    RequestSniffableWebView: typeof RequestSniffableWebView
    CancelSnifferRequest: typeof CancelSnifferRequestMessage
    SniffingComplete: typeof SniffingComplete
    Open: typeof OpenMessage
    PageAction: typeof PageActionMessage
    SetSnifferStatus: typeof SetSnifferStatus
    EnsureSnifferVisible: typeof EnsureSnifferVisible
  }
>

/**
 * Slice-level bridge between the embedded collector SPA and the Tauri
 * host. Web→Host carries control signals (`RequestSniffableWebView`,
 * `CancelSnifferRequest`, `SniffingComplete`, `SetSnifferStatus`,
 * `EnsureSnifferVisible`) and script-driven navigation steps (`Open`,
 * `PageAction`); Host→Web carries the sniffer-event subset collector parses, the
 * `PageLoaded` notification that drives the step timer, and the `UserDismissed`
 * signal that the user closed the sniffer webview. `SetSnifferStatus` is a pure
 * chrome-label update the host writes to the sniffer webview's subtitle; it is
 * host-consumed and never forwarded into the sniffed page.
 *
 * `PageAction` is the same `PageActionMessage` schema `BrowserSnifferBridge`
 * declares for its Host→Web side, so the Tauri host forwards the decoded
 * payload through both bridges without re-encoding. The six sniffer events
 * imported from `browser-sniffer-core` keep wire schemas in lockstep with
 * `BrowserSnifferBridge` for the same reason. `Cancelled` is the terminal
 * acknowledgement for a mid-stream `CancelSnifferRequest`; the handler uses
 * it to release the in-progress slot and offer a `Left(SnifferCancelled)`
 * onto its `results` mailbox.
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
    ['UserDismissed', UserDismissed],
  ] as const,
  webToHost: [
    ['RequestSniffableWebView', RequestSniffableWebView],
    ['CancelSnifferRequest', CancelSnifferRequestMessage],
    ['SniffingComplete', SniffingComplete],
    ['Open', OpenMessage],
    ['PageAction', PageActionMessage],
    ['SetSnifferStatus', SetSnifferStatus],
    ['EnsureSnifferVisible', EnsureSnifferVisible],
  ] as const,
})

export {
  CollectorBridge,
  EnsureSnifferVisible,
  OpenMessage,
  RequestSniffableWebView,
  SetSnifferStatus,
  SniffingComplete,
  UserDismissed,
}
