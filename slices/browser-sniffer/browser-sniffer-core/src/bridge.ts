import { Bridge } from 'effect-messaging-core'
import {
  CancelSnifferRequestMessage,
  LogMessage,
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
  },
  {
    Log: typeof LogMessage
    ResponseStart: typeof ResponseStartMessage
    ResponseData: typeof ResponseDataMessage
    ResponseFinished: typeof ResponseFinishedMessage
    RequestError: typeof RequestErrorMessage
    PageLoaded: typeof PageLoadedMessage
  }
>

/**
 * Cross-process contract for the injected `browser-sniffer-injected`
 * script. Web→Host: every shimmed `fetch` / XHR response, page-load
 * notifications, and ad-hoc log lines. Host→Web: `CancelSnifferRequest`
 * tells the page to stop pumping events for a given request id.
 *
 * Consumers (e.g. `collector-react`) re-export this bridge's
 * `webToHost` schemas as their own `Host→Web` messages to forward
 * sniffer traffic across nested bridges — see
 * `slices/collector/collector-core/src/bridge.ts` for the pattern.
 */
const BrowserSnifferBridge: BrowserSnifferBridge = Bridge.make({
  name: 'BrowserSniffer',
  hostToWeb: [['CancelSnifferRequest', CancelSnifferRequestMessage]] as const,
  webToHost: [
    ['Log', LogMessage],
    ['ResponseStart', ResponseStartMessage],
    ['ResponseData', ResponseDataMessage],
    ['ResponseFinished', ResponseFinishedMessage],
    ['RequestError', RequestErrorMessage],
    ['PageLoaded', PageLoadedMessage],
  ] as const,
})

export default BrowserSnifferBridge
