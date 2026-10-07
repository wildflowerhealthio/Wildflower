# AGENTS.md — global/tauri-unit-runner

The Tauri bindings of [`unit-runner`](../unit-runner/AGENTS.md), which runs an
app's long-lived background work as **units**. This crate binds that runner to
a Tauri app: the background session as `tauri-plugin-background-service`'s one
service, and whether the app is **present** from its window events, as two
plugins. It re-exports every public type of `unit-runner`.

Anything that doesn't need Tauri belongs in `unit-runner`: units, run
policies, statuses, starting and stopping runs per policy, runs, restarts and
the session ledger.
This crate keeps only what binds them to Tauri.

The vocabulary and the design are in `unit-runner`'s
[Design Explanation](../unit-runner/docs/Design%20Explanation.md), and the
Tauri side in this crate's
[Design Explanation](./docs/Design%20Explanation.md). Use their words (unit,
run, run state, stop reason, detail, run policy, present, absent, grace period,
background session, ended by platform, no longer needed, runner, host) in code
and docs here.
