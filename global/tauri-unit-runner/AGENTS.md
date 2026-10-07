# AGENTS.md — global/tauri-unit-runner

The Tauri bindings of [`unit-runner`](../unit-runner/AGENTS.md), which runs an
app's long-lived background work as **units**. This crate binds that runner to
a Tauri app: the keep-alive as `tauri-plugin-background-service`'s one service,
and whether the app is **open** from its window events, as two plugins. It
re-exports every public type of `unit-runner`.

Anything that doesn't need Tauri belongs in `unit-runner`: units, run
policies, statuses, the reconcile, runs, restarts and the keep-alive ledger.
This crate keeps only what binds them to Tauri.

The vocabulary and the design are in `unit-runner`'s
[Design Explanation](../unit-runner/docs/Design%20Explanation.md), and the
Tauri side in this crate's
[Design Explanation](./docs/Design%20Explanation.md). Use their words (unit,
run, run state, stop reason, detail, run policy, open, grace period,
keep-alive, revocation, runner, host) in code and docs here.
