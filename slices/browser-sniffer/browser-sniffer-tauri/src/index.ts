import { nativeSnifferBootstrapScript } from './native-bootstrap.generated.ts'
import { tauriSnifferBootstrapScript } from './tauri-bootstrap.generated.ts'

/**
 * Self-invoking JS source of the Tauri sniffer bootstrap, produced at build
 * time by `scripts/build-tauri-bootstrap.mts`. The Rust slice
 * `browser-sniffer-tauri-rust` embeds the same bytes via `include_str!` and
 * hands them to the `tauri-plugin-native-webview` plugin's `init_script` —
 * this TS export exists for tests, devtools, and any non-Rust consumer.
 *
 * Gated on `window.__TAURI__.event`, the bundle runs `installSniffer` over
 * a filter-wrapped event bus. No in-page chrome is injected — the plugin's
 * chrome bar (above the content webview on desktop, native toolbar on
 * mobile) owns the title/subtitle/message + back/forward/refresh slots.
 * When `__TAURI__` is absent the bundle no-ops.
 *
 * Length guard: a file below ~1000 chars almost certainly means the esbuild
 * step did not run — surface it loudly instead of injecting a silent no-op.
 */
const TAURI_SNIFFER_BOOTSTRAP_MIN_LENGTH = 1000
if (tauriSnifferBootstrapScript.length < TAURI_SNIFFER_BOOTSTRAP_MIN_LENGTH) {
  throw new Error(
    `browser-sniffer-tauri: tauriSnifferBootstrapScript is ${tauriSnifferBootstrapScript.length} chars, ` +
      `expected at least ${TAURI_SNIFFER_BOOTSTRAP_MIN_LENGTH}. ` +
      `The generated file 'tauri-bootstrap.generated.ts' looks empty or stale — ` +
      `run \`vp run generate-tauri-bootstrap\` to regenerate it. ` +
      `Script preview: ${tauriSnifferBootstrapScript.slice(0, 200)}`
  )
}

/**
 * Self-invoking JS source of the NATIVE sniffer bootstrap, produced at build
 * time by `scripts/build-native-bootstrap.mts`. The host passes these bytes as
 * the `tauri-plugin-native-webview` `open` command's `initScript` arg (and a
 * Rust crate may `include_str!` the matching `dist/native-bootstrap.js`).
 *
 * Gated on the native bridge (`window.webkit.messageHandlers.nativeWebview` /
 * `window.nativeWebview`), the bundle runs `installSniffer` over a
 * bridge-backed event bus. Like the Tauri bootstrap, no in-page chrome is
 * injected — the plugin's native chrome (UINavigationController on iOS,
 * Toolbar + bottom bar on Android) owns those slots. When no bridge is
 * present the bundle no-ops.
 *
 * Same length guard as `tauriSnifferBootstrapScript` above.
 */
const NATIVE_SNIFFER_BOOTSTRAP_MIN_LENGTH = 1000
if (nativeSnifferBootstrapScript.length < NATIVE_SNIFFER_BOOTSTRAP_MIN_LENGTH) {
  throw new Error(
    `browser-sniffer-tauri: nativeSnifferBootstrapScript is ${nativeSnifferBootstrapScript.length} chars, ` +
      `expected at least ${NATIVE_SNIFFER_BOOTSTRAP_MIN_LENGTH}. ` +
      `The generated file 'native-bootstrap.generated.ts' looks empty or stale — ` +
      `run \`vp run generate-native-bootstrap\` to regenerate it. ` +
      `Script preview: ${nativeSnifferBootstrapScript.slice(0, 200)}`
  )
}

export { nativeSnifferBootstrapScript, tauriSnifferBootstrapScript }
