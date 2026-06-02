import { snifferScriptSource } from './sniffer-script.generated.ts'

/**
 * Self-invoking JS source string of the sniffer, injected into sniffed
 * pages via `react-native-webview`'s
 * `injectedJavaScriptBeforeContentLoaded` (or `injectJavaScript` for live
 * re-injection), or embedded into inline HTML sources before the WebView
 * renders them.
 *
 * Produced at build time by `scripts/build-sniffer-script.mjs`, which
 * bundles `sniffer-entry.ts` (which imports and invokes
 * {@link installSniffer}) into a self-contained IIFE. The bundled
 * string is committed to source as `sniffer-script.generated.ts` so
 * Metro — which resolves this package via the `source` export
 * condition — sees the script without running a build step in the
 * consuming app.
 *
 * Why not `Function.prototype.toString()` at runtime: Hermes (RN/Expo)
 * strips function source after bytecode compilation, so the previous
 * ```
 * `(${installSniffer.toString()})()`
 * ```
 *  approach returned a syntactically
 * valid no-op (`(function () { [bytecode] })()`) on-device. Build-time
 * generation sidesteps that entirely.
 *
 * The length guard below trips if the generated file is empty or
 * mistakenly checked in stale — a louder failure than a silent no-op.
 */
const SNIFFER_SCRIPT_MIN_LENGTH = 1000
const snifferScript: string = snifferScriptSource
if (snifferScript.length < SNIFFER_SCRIPT_MIN_LENGTH) {
  throw new Error(
    `browser-sniffer-injected: snifferScript is ${snifferScript.length} chars, ` +
      `expected at least ${SNIFFER_SCRIPT_MIN_LENGTH}. ` +
      `The generated file 'sniffer-script.generated.ts' looks empty or stale — ` +
      `run \`vp run generate-sniffer-script\` to regenerate it. ` +
      `Script preview: ${snifferScript.slice(0, 200)}`
  )
}

export { installSniffer, SNIFFER_STATE_KEY } from './install-sniffer.ts'
export { snifferScript }
export type {
  SnifferInboundMessage,
  SnifferOutboundMessage,
  SnifferState,
  SnifferWindowExtensions,
} from './install-sniffer.ts'
