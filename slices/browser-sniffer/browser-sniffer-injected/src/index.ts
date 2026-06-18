import { snifferScriptSource } from './sniffer-script.generated.ts'

/**
 * Self-invoking JS source string of the sniffer, injected into sniffed
 * pages as the webview's pre-content initialization script (Tauri's
 * `WebviewWindowBuilder::initialization_script(...)`).
 *
 * Produced at build time by `scripts/build-sniffer-script.mjs`, which
 * bundles `sniffer-entry.ts` (which imports and invokes
 * {@link installSniffer}) into a self-contained IIFE. The bundled
 * string is committed to source as `sniffer-script.generated.ts` so
 * consumers resolving this package via the `source` export condition
 * see the script without running a build step.
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
