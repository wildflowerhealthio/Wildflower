/// <reference types="vite-plus/client" />

// Injected by Vite's `define` (see `vite.config.ts`), sourced from the
// shared `tauri-shared-config.json` so the loopback API origin matches the
// Rust server's binding. Absolute origin, e.g. `http://127.0.0.1:8080`.
declare const WILDFLOWER_LOOPBACK_ORIGIN: string

// Injected by Vite's `define` (see `vite.config.ts`), sourced from the shared
// `tauri-shared-config.json` so the WebView's device-login request asks for
// exactly the scopes gatekeeper-rust seeds for the `wildflower-host` client.
// A space-joined scope string, e.g. `system/*.cruds wildflower/*.cruds`.
declare const WILDFLOWER_LOCAL_GRANTED_SCOPES: string
