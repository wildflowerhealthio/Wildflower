import { nativeSnifferBootstrapScript } from './native-bootstrap.generated.ts'
import { tauriSnifferBootstrapScript } from './tauri-bootstrap.generated.ts'

/**
 * Self-invoking JS source of the Tauri sniffer bootstrap, produced at build
 * time by `scripts/build-tauri-bootstrap.mts`. The Rust slice
 * `browser-sniffer-tauri-rust` embeds the same bytes via `include_str!` and
 * hands them to `WebviewBuilder::initialization_script(...)` — this TS export
 * exists for tests, devtools, and any non-Rust consumer.
 *
 * Gated on `window.__TAURI__.event`, the bundle injects the in-page
 * `BrowserTopBar` and runs `installSniffer` over a filter-wrapped event bus;
 * see `tauri-sniffer-entry.ts` for the orchestration and `install-sniffer.ts`
 * for the wire format. When `__TAURI__` is absent it no-ops.
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
 * bridge-backed event bus and skips the in-page `BrowserTopBar` (the native
 * toolbar replaces it). When no bridge is present it no-ops.
 *
 * Same length guard as the Tauri bootstrap: a tiny file means the esbuild step
 * did not run.
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
