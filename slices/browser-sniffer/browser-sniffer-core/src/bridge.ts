import { Bridge } from 'effect-messaging-core'
import {
  CancelSnifferRequestMessage,
  CancelledMessage,
  ClickMessage,
  PageLoadedMessage,
  RequestErrorMessage,
  ResponseDataMessage,
  ResponseFinishedMessage,
  ResponseStartMessage,
} from './messages.ts'

type BrowserSnifferBridge = Bridge.Bridge<
  'BrowserSniffer',
  {
    CancelSnifferRequest: typeof CancelSnifferRequestMessage
    Click: typeof ClickMessage
  },
  {
    ResponseStart: typeof ResponseStartMessage
    ResponseData: typeof ResponseDataMessage
    ResponseFinished: typeof ResponseFinishedMessage
    RequestError: typeof RequestErrorMessage
    Cancelled: typeof CancelledMessage
    PageLoaded: typeof PageLoadedMessage
  }
>

/**
 * Cross-process contract for the injected `browser-sniffer-injected`
 * script. Web→Host: every shimmed `fetch` / XHR response, page-load
 * notifications, and mid-stream cancel acknowledgements. Host→Web:
 * `CancelSnifferRequest` tells the page to stop pumping events for a
 * given request id (the page then posts `Cancelled` as the terminal
 * observation).
 *
 * `PageLoaded` carries the page URL and a `pageContentId` that
 * correlates with a `Response*` stream containing
 * `documentElement.outerHTML`; subscribe to that stream if you need
 * the DOM body.
 *
 * Consumers (e.g. `collector-react`) re-export this bridge's
 * `webToHost` schemas as their own `Host→Web` messages to forward
 * sniffer traffic across nested bridges — see
 * `slices/collector/collector-core/src/bridge.ts` for the pattern.
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
    ['Click', ClickMessage],
  ] as const,
  webToHost: [
    ['ResponseStart', ResponseStartMessage],
    ['ResponseData', ResponseDataMessage],
    ['ResponseFinished', ResponseFinishedMessage],
    ['RequestError', RequestErrorMessage],
    ['Cancelled', CancelledMessage],
    ['PageLoaded', PageLoadedMessage],
  ] as const,
})

export { BrowserSnifferBridge }
