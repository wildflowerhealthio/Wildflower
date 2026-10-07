# AGENTS.md — global/unit-runner

Runs an app's long-lived background work as **units**, on any platform. Each
unit has a **run policy**. `UnitRunner` starts and stops units to match their
policies, restarts the ones that fail, asks its host for one background session
while any should run, and reports each unit's status and **detail**. This is
`global/` code: it knows nothing about what a unit does, and nothing about the
platform. The app supplies the units and stores their policies; a host crate
(`../tauri-unit-runner`) binds `UnitRunner` to Tauri.

Keep this crate free of `tauri` and `tauri-plugin-*` dependencies: it exists so
an app's domain crates can define units and store run policies without
depending on Tauri. Platform code belongs in the host crate, behind the
`BackgroundSessionPlatform` port and `UnitRunner`'s host calls.

The vocabulary and the design are in
[Design Explanation](./docs/Design%20Explanation.md). Use its words (unit, run,
run state, stop reason, detail, run policy, open, grace period, background
session, ended by platform, no longer needed, runner, host) in code and docs
here.
