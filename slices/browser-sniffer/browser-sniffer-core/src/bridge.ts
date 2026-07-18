import { Bridge, type MessageHandler } from 'effect-messaging-core'
import {
  CancelSnifferRequestMessage,
  CancelledMessage,
  MatchesFoundMessage,
  PageActionMessage,
  PageLoadedMessage,
  QueryMatchesMessage,
  RequestErrorMessage,
  ResponseDataMessage,
  ResponseFinishedMessage,
  ResponseStartMessage,
} from './messages.ts'

type BrowserSnifferBridge = Bridge.Bridge<
  'BrowserSniffer',
  {
    CancelSnifferRequest: typeof CancelSnifferRequestMessage
    PageAction: typeof PageActionMessage
    QueryMatches: typeof QueryMatchesMessage
  },
  {
    ResponseStart: typeof ResponseStartMessage
    ResponseData: typeof ResponseDataMessage
    ResponseFinished: typeof ResponseFinishedMessage
    RequestError: typeof RequestErrorMessage
    Cancelled: typeof CancelledMessage
    PageLoaded: typeof PageLoadedMessage
    MatchesFound: typeof MatchesFoundMessage
  }
>

/**
 * Cross-process contract for the injected sniffer (`browser-sniffer-tauri`'s
 * `installSniffer`). Web→Host: every shimmed `fetch` / XHR response, page-load
 * notifications, and mid-stream cancel acknowledgements. Host→Web:
 * `CancelSnifferRequest` tells the page to stop pumping events for a
 * given request id (the page then posts `Cancelled` as the terminal
 * observation); `PageAction` is the scripted-interaction control message
 * (a `Click` / `Fill` action demuxed by its inner `kind`), best-effort
 * with no acknowledgement; `QueryMatches` asks the page to enumerate the
 * live DOM (`querySelectorAll`) and is answered by a single `MatchesFound`
 * on Web→Host — the request/response pair backing the collector's `ForEach`
 * runtime link discovery (correlated by `queryId`).
 *
 * `PageLoaded` carries the page URL and a `pageContentId` that
 * correlates with a `Response*` stream containing
 * `documentElement.outerHTML`; subscribe to that stream if you need
 * the DOM body.
 *
 * Consumers (e.g. `collector-react`) re-export this bridge's
 * `webToHost` schemas as their own `Host→Web` messages to forward
 * sniffer traffic across nested bridges — see
 * `slices/collector/collector-registry/src/bridge.ts` for the pattern.
 *
 * @remarks
 * Cross-process `console.<level>(...)` mirroring is handled by the
 * shared `LogBridge` in `effect-messaging-core`; the injected sniffer
 * posts `{ _tag: 'Log', level, payload }` wire messages whose shape
 * already matches `LogBridge`'s schema, so the host shell composes
 * `LogBridge` into the same transport tuple to receive them.
 */
const BrowserSnifferBridge: BrowserSnifferBridge = Bridge.make({
  name: 'BrowserSniffer',
  hostToWeb: [
    ['CancelSnifferRequest', CancelSnifferRequestMessage],
    ['PageAction', PageActionMessage],
    ['QueryMatches', QueryMatchesMessage],
  ] as const,
  webToHost: [
    ['ResponseStart', ResponseStartMessage],
    ['ResponseData', ResponseDataMessage],
    ['ResponseFinished', ResponseFinishedMessage],
    ['RequestError', RequestErrorMessage],
    ['Cancelled', CancelledMessage],
    ['PageLoaded', PageLoadedMessage],
    ['MatchesFound', MatchesFoundMessage],
  ] as const,
})

/**
 * Per-tag handler record a host must supply for {@link BrowserSnifferBridge}'s
 * `Web→Host` events (`ResponseStart`, `ResponseData`, `ResponseFinished`,
 * `RequestError`, `Cancelled`, `PageLoaded`). Each handler takes the
 * decoded message and returns `Effect<void>`. Defined here so the host
 * adapter (`browser-sniffer-tauri-rust` and the `browser-sniffer-tauri`
 * bootstrap) and any wrapper around it share one definition rather
 * than re-deriving it from the bridge.
 */
type SnifferHandlers = MessageHandler.HandlersFor<typeof BrowserSnifferBridge.WebToHost>

export { BrowserSnifferBridge }
export type { SnifferHandlers }
