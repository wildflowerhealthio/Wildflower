# AGENTS.md — global/tauri-unit-runner

Runs a Tauri app's long-lived background work as **units**. Each unit has a
**run policy**. The runner starts and stops units to match their policies,
restarts the ones that fail, keeps the app alive with one background-service
task for all of them, and reports each unit's status and **detail**. This is
`global/` code: it knows nothing about what a unit does. The app supplies the
units and stores their policies.

The vocabulary and the design are in
[Design Explanation](./docs/Design%20Explanation.md). Use its words (unit, run,
run state, stop reason, detail, run policy, open, grace period, keep-alive,
revocation, runner) in code and docs here.
