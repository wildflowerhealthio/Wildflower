# Follow-up plan — bridge-multiplex review (needs a local Rust/Tauri build)

These items came out of the bridge-multiplex code review on branch
`claude/eloquent-brahmagupta-2xoqvp`. They are **not** done because the
web execution sandbox can't compile the Tauri Rust crate (missing
`gdk-3.0`/`webkit2gtk` system libs), so they can't be `cargo
check`/`cargo nextest`-verified there. Each item below is written so an
agent (or human) with a working local toolchain can execute and verify
it.

Toolchain reminder: drive everything through `vp` (never `pnpm`/`npm`
directly). Rust verification is `cargo check` / `cargo nextest run` (or
`cargo test`) inside the relevant crate; full app verification is
`vp run build:ios:prod` / launching the Tauri app.

Already landed on this branch (context, no action needed):
`92bae2d` allow http(s) Uri sources · `1101bad` surface dropped emits ·
`6b5adf3` JSON-viewer retry + tests · `d8ef7b3` source-guard + slim
filter · plus the earlier doc/test/dedupe commit.

---

## 1. Scope the gatekeeper bearer token off the shared bridge bus (security) — was review finding #1

### Why

`apps/wildflower-tauri/src-tauri/src/bridge.rs` emits `AuthTokenIssued`
(a full-Owner bearer token) and `DeviceConsentRequested` (a device
pairing `user_code`) on the single broadcast `BRIDGE_EVENT` channel. The
browser-sniffer `WebviewWindow` loads arbitrary, possibly-hostile EHR
pages, shares its JS context with the injected bootstrap, and is granted
`core:event:default` (see `src-tauri/capabilities/browser-sniffer.json`).

**`emit_to("main", …)` does NOT fix this** — verified against
tauri 2.11.2: `Emitter::emit_to` delivers to _every_ webview and filters
per-registered-listener; `match_any_or_filter` short-circuits to `true`
for any listener whose target is `EventTarget::Any`, which is the JS
default (`@tauri-apps/api/event` `listen` → `{ kind: 'Any' }`). A hostile
page in the sniffer webview can register its own `Any` `listen('bridge',
…)` and receive anything delivered to that webview. So the token must not
travel on a bus the sniffer webview can subscribe to at all.

### Fix: command-pull (capability-scoped)

Tauri commands are gated per-window by capabilities. The main window's
capability (`capabilities/default.json`) grants the command; the
sniffer's (`capabilities/browser-sniffer.json`) does not — so only the
main webview can pull the token.

Note: this app currently defines **no** Tauri commands, so
`.invoke_handler(tauri::generate_handler![…])` must be added to the
builder in `apps/wildflower-tauri/src-tauri/src/lib.rs:187` (`run()`).

#### Rust steps (`apps/wildflower-tauri/src-tauri/src/`)

1. In `bridge.rs`, keep the `host_owner_token_sender` watch channel as
   the source of truth. Expose the current value to a command: put a
   readable handle in Tauri managed state, e.g.

   ```rust
   pub struct GatekeeperTokenState {
       pub token_rx: tokio::sync::watch::Receiver<Option<String>>,
   }
   ```

   `attach_bridge` already owns `token_rx`; return a clone in
   `BridgePublishers` (or call `app.manage(GatekeeperTokenState { token_rx: token_rx.clone() })`
   from `attach_bridge`). `watch::Receiver` is `Clone`.

2. Add the command (in `bridge.rs` or a small `commands.rs`):

   ```rust
   #[tauri::command]
   fn gatekeeper_current_token(
       state: tauri::State<'_, GatekeeperTokenState>,
   ) -> Option<String> {
       state.token_rx.borrow().clone()
   }
   ```

3. Register it in `lib.rs` `run()`:
   `.invoke_handler(tauri::generate_handler![gatekeeper_current_token])`,
   and `app.manage(...)` the state inside `.setup()` (after
   `attach_bridge`).

4. **Stop emitting `AuthTokenIssued` on the bus.** In `attach_bridge`'s
   spawned task, replace the `emit_auth_token(...)` calls with a
   _contentless_ re-pull signal so the web side knows to re-pull on a
   mid-session re-mint without putting the secret on the bus, e.g. emit
   `{ "_tag": "AuthTokenChanged" }` (no token field). Delete
   `emit_auth_token`. Keep the `__Ready` arm so the web pulls on first
   load too (or rely solely on the web pulling on boot + on
   `AuthTokenChanged`).

#### Capability steps (`apps/wildflower-tauri/src-tauri/capabilities/`)

- `default.json` (main window): grant the command permission. For
  app-defined commands Tauri generates an `allow-…` permission; confirm
  the exact identifier locally (e.g. `"gatekeeper-current-token"` or the
  generated form) and add it to the main capability's `permissions`.
- `browser-sniffer.json`: leave as-is (it must NOT grant the command).
  Confirm by attempting `invoke('gatekeeper_current_token')` from the
  sniffer context and asserting it's rejected as not-allowed.

#### Web steps (`slices/gatekeeper/gatekeeper-react/` + `apps/wildflower-react/`)

- Token bootstrap currently flows through the `AuthTokenIssued` handler:
  `apps/wildflower-react/src/bridges/boot-stable-handlers.ts`,
  `slices/gatekeeper/gatekeeper-react/src/client/{token-storage.ts,auth-ready.ts}`,
  `slices/gatekeeper/gatekeeper-react/src/web-bridge.ts`.
- On boot (and on the new `AuthTokenChanged` notification) call
  `invoke('gatekeeper_current_token')` and feed the result into the same
  token store the `AuthTokenIssued` handler fed. Remove the
  `AuthTokenIssued` host→web handler from `GatekeeperBridge` /
  boot-stable-handlers (and the wire schema in
  `slices/gatekeeper/gatekeeper-core/src/bridge.ts`) once nothing emits it.
- Keep this behind the Tauri-platform path only; the web/dev transports
  that still use a pushed token (if any) are unaffected — check
  `web-bridge.ts` and the non-Tauri transports before deleting the
  `AuthTokenIssued` schema entirely.

#### Device-consent (`DeviceConsentRequested.user_code`) — decide

The `user_code` is also sensitive and also broadcast, but the consent
flow is an _event with a side effect_ (it raises/focuses the main window
on a `None → Some` transition), so a plain pull doesn't fit. Options:

- **(a) Notify-then-pull** (matches the token fix): emit a contentless
  `DeviceConsentChanged` on the bus (no `user_code`), keep the
  window-raise host-side, and add a capability-scoped
  `gatekeeper_active_user_code` command the main webview pulls. Robust;
  more work.
- **(b) Accept the exposure**: the `user_code` is short-lived and only
  useful during operator pairing — lower risk than the Owner token.
  Cheapest; document the residual risk.

Recommend (a) if the pairing code is considered sensitive; otherwise (b).
Confirm with the product owner.

### Verification

- `cargo nextest run -p wildflower-tauri` (bridge tests) and `cargo check`.
- Launch the app: main webview authenticates (token pulled); open the
  sniffer and confirm (via a temporary `listen('bridge', …)` probe in the
  sniffer page, or DevTools) that no `AuthTokenIssued`/token payload ever
  arrives there. Confirm `invoke('gatekeeper_current_token')` from the
  sniffer is denied by capability.
- `vp test` for the gatekeeper-react / wildflower-react changes.

---

## 2. Hoist `BridgeEnvelope` + `BRIDGE_EVENT` into `shared-structures-rust` (#11)

### Why

`BridgeEnvelope { #[serde(rename = "_tag")] tag: String }` and
`const BRIDGE_EVENT: &str = "bridge"` are duplicated byte-for-byte in:

- `apps/wildflower-tauri/src-tauri/src/bridge.rs`
- `slices/browser-sniffer/browser-sniffer-tauri-rust/src/events.rs`

Both crates compile together; a divergence (channel name or discriminator
field) would silently break tag routing with no compile error.

### Steps

1. In `slices/shared-structures/shared-structures-rust/`:
   - Add `src/bridge.rs`:

     ```rust
     use serde::Deserialize;

     /// Single multiplexed bridge channel — must match the TS side in
     /// `global/effect-messaging/effect-messaging-tauri/src/event-names.ts`.
     pub const BRIDGE_EVENT: &str = "bridge";

     /// `_tag` discriminator peek shared by every Rust bridge listener.
     #[derive(Debug, Deserialize)]
     pub struct BridgeEnvelope {
         #[serde(rename = "_tag")]
         pub tag: String,
     }
     ```

   - `pub mod bridge;` + re-export in `src/lib.rs`.
   - `shared-structures-rust` currently has only optional deps; add
     `serde = { workspace = true }` as a **non-optional** dependency
     (it's needed for the `Deserialize` derive in the always-on module).
     Confirm this doesn't regress the `openapi-snapshot` feature gating.

2. `browser-sniffer-tauri-rust/Cargo.toml`: add
   `shared-structures-rust = { path = "../../shared-structures/shared-structures-rust" }`.
   `wildflower-tauri` already depends on it.
3. Replace the local definitions:
   - `bridge.rs`: delete the local `BRIDGE_EVENT` + `BridgeEnvelope`,
     import from `shared_structures_rust::bridge::{BRIDGE_EVENT, BridgeEnvelope}`.
   - `events.rs`: same (it currently re-declares both; keep the
     crate-specific tag literals like `REQUEST_SNIFFABLE_WEBVIEW`).
   - The per-crate drift tests (`event_name_and_tags_match_the_ts_convention`,
     `bridge_event_and_tags_match_the_ts_convention`) keep asserting
     `BRIDGE_EVENT == "bridge"`; they now assert the shared const, which
     is the point. Keep one of them (or add one in shared-structures-rust)
     so the TS↔Rust literal stays pinned.

### Verification

- `cargo check` for `shared-structures-rust`, `browser-sniffer-tauri-rust`,
  and `wildflower-tauri`.
- `cargo nextest run -p shared-structures-rust -p browser-sniffer-tauri-rust -p wildflower-tauri`.

---

## 3. (Optional, low priority) Cross-channel tag-uniqueness guard (#9)

`assertUniqueTags` in
`global/effect-messaging/effect-messaging-tauri/src/tauri-transport.ts`
only checks tags within a single `makeTauriTransport` call, but the
`bridge` channel is shared across the main transport, the raw sniffer,
and the Rust listeners. There's no current bug (one transport; the
sniffer reuses `CollectorBridge`'s tags), so this is only a future
footgun. If desired, add a repo-level test that collects every tag used
on `bridge` across all bridges and asserts global uniqueness. Otherwise a
doc note on `assertUniqueTags` explaining the cross-process collision
domain is enough.

---

## Resolved during the review (no further action)

- **#5 (JSON snapshot):** the maintainer confirmed iOS WKWebView renders
  `application/json` inline as `<pre>`, so the (now JSON-scoped) page-load
  retry is sound.
- **#7 (per-chunk delivery to the main webview):** false positive — the
  main webview _is_ the collector consumer of the sniffer's `ResponseData`;
  the broadcast is the intended data path.
- **#12 (build-script order):** the `vp pack && generate` order is correct
  in practice (`vp pack` cleans `dist/`, so `dist/tauri-bootstrap.js` must
  be written after). The only theoretical staleness — the bootstrap string
  embedded in `dist/index.js` — is never consumed in-repo (the `source`
  export condition resolves to `src/`) and the package is `private`. If
  the package is ever published, emit the IIFE from a pack `writeBundle`
  hook so both outputs are produced in one pass.
