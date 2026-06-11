/// <reference types="vite-plus/client" />

// Injected by Vite's `define` (see `vite.config.ts`), sourced from the
// shared `api-origin.json` so the loopback API origin matches the Rust
// server's binding. Absolute origin, e.g. `http://127.0.0.1:8080`.
declare const WILDFLOWER_API_ORIGIN: string
