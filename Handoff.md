# Handoff

## What we're doing and why

PR #224 (`claude/pr-202-tunnel-seam`) is the **verified-liveness tunnel** feature: the
tunnel only advertises its public origin once a `/health` probe through that origin
comes back healthy. This session started as a `/code-review` of the PR and turned into
**debugging why launching a tunnel-requiring app didn't work**, with live logs from the
user's Tauri build driving each step.

Net story of the bug hunt:

- The tunnel **comes up and verifies fine** (~1s; `/health` probe ~100–200ms). The
  earlier "verify deadline too tight" theory was **disproven by logs** — it's not a
  timing problem.
- The real failure: a reconcile to a **new settings revision cancels the live, just-
  verified supervisor**, which tears rathole down and re-dials from scratch → the tunnel
  **flaps**. A launch that handed the webview the public origin then had it yanked.
- **Settings toggle now works** (~1.1s) because `PUT /tunnel` was routed through the
  same await-verified seam the launch uses.
- **Launch had two failure modes**, both now addressed:
  1. `tunnel.running` true → navigate direct to `servedOrigin` → a spurious rev-bump
     settings write flapped it (root source still unconfirmed — see open questions).
  2. `tunnel.running` false → `requestTunnel()` bridge → **no `RequestTunnel` host
     handler existed in the Tauri app** (only the now-deleted Expo one) → 8s timeout
     "tunnel request timed out — host unreachable". **Fixed** by wiring the handler.

## What's done (all committed + pushed on `claude/pr-202-tunnel-seam`)

Newest first:

- `e61c577` — **Launch gate on `verified`, not `running`.** `home/index.tsx` now uses a
  pure `launchTarget(app, tunnel)` helper: non-tunnel→loopback, tunnel+`verified`→direct
  `servedOrigin`, otherwise→bridge. (`running` includes `dialing`/`unreachable` where
  `servedOrigin` is still loopback, so the old gate could bypass the tunnel.) Helper +
  unit test in `slices/apps/apps-react/src/routes/_auth/home/launch-target.{ts,test.ts}`.
- `46b24b1` — **Wired the `RequestTunnel` bridge handler for Tauri.** New
  `apps_rust::bridge` (`AppsHostToWeb::{TunnelStarted{origin},TunnelFailed{reason}}`,
  golden-tested against `apps-core/bridge.ts`). New
  `wildflower-tauri::bridge::attach_apps_tunnel_bridge(app, tunnel)` listens on the
  bridge event, decodes **only** `RequestTunnel`, spawns `TunnelService::try_start()`,
  emits the verified origin or failure. Wired in `run_server` (threaded an `AppHandle`).
- `3ee6d29` — Diagnostic: reconcile-cancel log now prints `new_requested_running` /
  `public_host_changed` / `relay_changed` so a flap names the field that differed.
- `66471e5` — **The two main fixes (Part A + B):**
  - **Part A (flap fix):** `reconcile` no longer tears down a live tunnel when the new
    revision's **dialable config (relay + public_host) is unchanged** and it's still
    requested on — it returns early, leaving the supervisor untouched. Only a real
    relay/host change (or off/misconfigured) cancels + re-dials. `SupervisorHandle` now
    carries `relay_settings`/`public_host` for the comparison.
  - **Part B:** `PUT /tunnel` routes through `control::await_verified` (extracted from
    `start_and_verify`), so a save reports **real** reachability (verified/unreachable/
    deadline) instead of optimistic `dialing`. A no-op save returns `verified`
    immediately. **Behavior change:** a genuine turn-on PUT now blocks up to the verify
    deadline (~4s).
- `407d58e`, `12247e3`, `0ddb34c` — Instrumentation (still in the tree, useful): per-dial
  / per-probe / per-transition logs in the daemon, `start_and_verify` timing, `run_once`
  exit-cause (self-exit vs cancel), and **rathole pinned to `info`** in the Tauri log
  config (`.level_for("rathole", Info)`).
- `c1dcd9e` — The original `/code-review` fixes: derive the verify deadline from
  `ProbeTiming` (`interval+timeout`); clean dial exit publishes `Dialing` not an
  errorless `Unreachable`; dropped `TunnelStatusWire` (now `TunnelStatus` derives
  serde+`ToSchema` directly in shared-structures); deleted dead `TunnelControl`
  inherent methods; shared test doubles (`tunnel-rust/src/test_support.rs`); fixed a
  rustdoc link; **dropped the whole mpsc/oneshot/resident-task control seam** —
  `TunnelControl` now just holds `Arc<TunnelState>` and `request_start` calls
  `start_and_verify` inline.

Rust verified locally: `cargo test`/`clippy --all-features` green for `tunnel-rust`
(37 tests), `apps-rust` (45), `shared-structures-rust`. OpenAPI snapshot regenerated.

## What remains

1. **Confirm the launch works end-to-end** on the user's build with all of the above
   (the bridge handler + verified gate are the last pieces and were never compiled here).
2. **Root-cause the spurious `revision=12` settings PUT** that flapped a verified tunnel
   in the *first* launch log (see open questions). Part A makes the tunnel robust to it,
   so it's no longer urgent, but it's unexplained. The `*_changed` diagnostic will name
   the field on the next flap.
3. **Decide whether the verify-deadline / cold-start logging stays or gets trimmed**
   before merge — several `tracing::info!/debug!` lines were added for this hunt.
4. **Possibly loosen the skip comparison** to ignore relay *token*-only re-sends (compare
   `remote_addr`/`service_name`/`public_key`, not the token) if the rev-12 culprit turns
   out to be a token re-send — pending the diagnostic.

## Key files to read first

- `slices/tunnel/tunnel-rust/src/domain/tunnel_daemon.rs` — `reconcile` (skip-when-
  unchanged + cancel diagnostic), `supervise`, `set_state`, `dial_with_probes`,
  `verify_deadline`.
- `slices/tunnel/tunnel-rust/src/control.rs` — `start_and_verify`, `await_verified`,
  `verdict`, `persist_start`. The control seam.
- `slices/tunnel/tunnel-rust/src/relay_clients/rathole.rs` — `run_once` and the rathole
  shutdown mechanism (see gotchas).
- `apps/wildflower-tauri/src-tauri/src/bridge.rs` + `lib.rs` — the new
  `attach_apps_tunnel_bridge` and its `run_server` wiring.
- `slices/apps/apps-react/src/routes/_auth/home/{index.tsx,launch-target.ts}` +
  `runtime/use-request-tunnel.ts` — the launch flow and the 8s bridge timeout.

## Gotchas and context the next agent needs

- **Cannot build the Tauri crate here** (`wildflower-tauri` needs GTK/`gdk-3.0`, absent
  in the sandbox). **Cannot run TS tests here** (`vp`/`vite-plus` not installed). Both
  are verified only by CI (`ci-rust-tauri.yml` + the vitest projects). The bridge handler
  and `launch-target` were written to mirror existing patterns exactly but were never
  compiled/run locally — **check CI**.
- **rathole `"Unable to listen for shutdown signal: channel closed"` is a SYMPTOM, not
  the cause.** rathole is built `default-features=false` (no `notify`), so its config
  watcher is a stub that only `await`s the shutdown receiver we pass. `rathole::run()`
  ends the instant our `shutdown_tx` drops — which happens when the supervisor's
  `run_once` future is dropped on cancel. So that error == "the supervisor was
  cancelled." Don't chase the rathole error; chase **what issued the reconcile that
  cancelled it.** The decisive log was `rathole: cancellation requested` (our own
  `run_once` cancel branch firing) → it *was* a cancel, i.e. a reconcile.
- **`running` ≠ `verified`.** `TunnelStatus::is_running()` is `dialing|verified|
  unreachable`. `servedOrigin` is the public origin **only** while `verified`. Anything
  keying reachability off `running` is subtly wrong (this bit the launch gate).
- **`utoipa` now leaks into the `tunnel-service` feature** of shared-structures (so
  `TunnelStatus` can derive `ToSchema`). The user explicitly approved this — it only ends
  up in the app binary, never the lean default build.
- **Tauri bridge echo:** `app.emit(BRIDGE_EVENT, …)` echoes back to `app.listen` on the
  same event. The apps handler **must** filter to `RequestTunnel` only (`is_request_tunnel`)
  or it'll re-trigger on its own `TunnelStarted`/`TunnelFailed` emits.
- **The bridge listener is attached in `run_server` (async), not `setup()` (sync)** — it
  needs the `tunnel_service`, which is built there. Tiny window where an early
  `RequestTunnel` could miss, but nothing can launch before the server is up, so fine.
- **`PUT /tunnel` now blocks** up to the verify deadline on a genuine turn-on/config
  change (await-verified). No-op saves return immediately. This replaced the deliberate
  "immediate `dialing`" design — the old `put_…_reports_dialing` test was reworked.
- **The launch never issues a `PUT`.** `GET /apps/:id` fast-paths on a verified tunnel
  (no reconcile); `requestTunnel()` is a bridge message that calls `try_start` (also
  fast-paths). So any rev-bump at launch time is an *external* settings write — suspect
  the tunnel **settings form's** React Query `onSettled` refetch / optimistic re-PUT, a
  relay token re-send, or a `requestedRunning` flip. Unconfirmed.
- Reconcile's monotonic guard means a same-revision reconcile (e.g. `persist_start` when
  already requested-on) is skipped by the stale check before the dialable-config check.

## Current state

- Branch: `claude/pr-202-tunnel-seam` (the PR head). **Working tree clean, all pushed**
  (HEAD `e61c577`).
- PR #224 is a **draft**; this session posted a `COMMENT` review earlier and then made
  all the above fix commits on top.
- Develop on this branch only (per the session's git rules); the user pushes via their
  own flow but in this session pushes have been done directly to `origin`.
