import { installSniffer } from './install-sniffer.ts'

/**
 * JS-source string of {@link installSniffer}'s body, self-invoking.
 *
 * Produced via `Function.prototype.toString()` at module-load time —
 * works identically in source-condition (tsdown/swc-stripped TS) and
 * built-condition (tsdown-emitted JS) because both yield runtime JS the
 * engine parses and stringifies. Consumers inject this string into a
 * WebView via `react-native-webview`'s `injectedJavaScriptBeforeContentLoaded`
 * (or `injectJavaScript` for live re-injection).
 *
 * Constraint that makes this work: {@link installSniffer} declares no
 * module-scope value dependencies — every helper is nested inside the
 * function body. See `install-sniffer.ts` for the reasoning.
 */
const snifferScript: string = `(${installSniffer.toString()})()`

export { installSniffer, SNIFFER_STATE_KEY } from './install-sniffer.ts'
export { snifferScript }
export type {
  SnifferInboundMessage,
  SnifferOutboundMessage,
  SnifferState,
  SnifferWindowExtensions,
} from './install-sniffer.ts'
