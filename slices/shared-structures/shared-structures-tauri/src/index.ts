import { sandboxedWebViewBootstrapScript } from './tauri-bootstrap.generated.ts'

/**
 * Self-invoking JS source of the sandboxed-webview bootstrap, produced at build
 * time by `scripts/build-tauri-bootstrap.mts`. The Rust crate
 * `shared-structures-tauri-rust` embeds the same bytes via `include_str!` and
 * hands them to `WebviewWindowBuilder::initialization_script(...)` — this TS
 * export exists for tests, devtools, and any non-Rust consumer.
 *
 * Gated on `window.__TAURI__.event`, the bundle injects the in-page browser top
 * bar (Back / Reload / URL); see `sandboxed-webview-entry.ts` for the
 * orchestration and `inject-browser-top-bar.ts` for the bar itself. When
 * `__TAURI__` is absent it no-ops (nowhere to send the close signal).
 *
 * Length guard: a file below ~1000 chars almost certainly means the esbuild
 * step did not run — surface it loudly instead of injecting a silent no-op.
 */
const SANDBOXED_WEBVIEW_BOOTSTRAP_MIN_LENGTH = 1000
if (sandboxedWebViewBootstrapScript.length < SANDBOXED_WEBVIEW_BOOTSTRAP_MIN_LENGTH) {
  throw new Error(
    `shared-structures-tauri: sandboxedWebViewBootstrapScript is ${sandboxedWebViewBootstrapScript.length} chars, ` +
      `expected at least ${SANDBOXED_WEBVIEW_BOOTSTRAP_MIN_LENGTH}. ` +
      `The generated file 'tauri-bootstrap.generated.ts' looks empty or stale — ` +
      `run \`vp run generate-tauri-bootstrap\` to regenerate it. ` +
      `Script preview: ${sandboxedWebViewBootstrapScript.slice(0, 200)}`
  )
}

export { sandboxedWebViewBootstrapScript }
