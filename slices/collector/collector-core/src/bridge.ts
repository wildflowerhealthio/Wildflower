import {
  RequestErrorMessage,
  ResponseDataMessage,
  ResponseFinishedMessage,
  ResponseStartMessage,
} from 'browser-sniffer-core'
import { Schema } from 'effect'
import { Bridge } from 'effect-messaging-core'

/**
 * Web → Host: the collector SPA asks the host to open a sniffer-enabled
 * WebView for the given `source`. The host opens a screen with
 * `<BrowserSnifferWebView>` and forwards the resulting sniffer events
 * back through this same bridge's Host→Web channel.
 *
 * The `source` shape mirrors `EffectMessagingWebViewSource` (and
 * `browser-sniffer-expo`'s `BrowserSnifferWebViewSource`) so the host
 * can pass it straight through.
 */
const RequestSniffableWebView = Schema.parseJson(
  Schema.TaggedStruct('RequestSniffableWebView', {
    source: Schema.Union(
      Schema.TaggedStruct('Uri', { uri: Schema.String }),
      Schema.TaggedStruct('Html', {
        html: Schema.String,
        baseUrl: Schema.optional(Schema.String),
      })
    ),
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

type CollectorBridge = Bridge.Bridge<
  'Collector',
  {
    ResponseStart: typeof ResponseStartMessage
    ResponseData: typeof ResponseDataMessage
    ResponseFinished: typeof ResponseFinishedMessage
    RequestError: typeof RequestErrorMessage
  },
  {
    RequestSniffableWebView: typeof RequestSniffableWebView
    SniffingComplete: typeof SniffingComplete
  }
>

/**
 * Slice-level bridge between the embedded collector SPA and the Expo
 * host. Web→Host carries control signals (`RequestSniffableWebView`,
 * `SniffingComplete`); Host→Web carries the sniffer-event subset
 * collector parses.
 *
 * The four sniffer events imported from `browser-sniffer-core` keep
 * wire schemas in lockstep with `BrowserSnifferBridge` — the host can
 * forward a decoded message through this bridge's Host→Web sender
 * without re-encoding.
 */
const CollectorBridge: CollectorBridge = Bridge.make({
  name: 'Collector',
  hostToWeb: [
    ['ResponseStart', ResponseStartMessage],
    ['ResponseData', ResponseDataMessage],
    ['ResponseFinished', ResponseFinishedMessage],
    ['RequestError', RequestErrorMessage],
  ] as const,
  webToHost: [
    ['RequestSniffableWebView', RequestSniffableWebView],
    ['SniffingComplete', SniffingComplete],
  ] as const,
})

export default CollectorBridge
export { RequestSniffableWebView, SniffingComplete }
