# unit-runner

Runs an app's long-lived background work as **units**. Each unit has a **run
policy**. `UnitRunner` starts and stops units to match their policies, restarts
the ones that end on their own, asks the platform for one background session
while any of them should run, and reports each unit's status. It knows nothing
about what a unit does: the app supplies the units, stores their policies, and
owns its own wire and notifications.

This crate has no Tauri dependency, so an app's domain crates can define units
and store run policies without depending on Tauri.
[`tauri-unit-runner`](../tauri-unit-runner/README.md) binds it to a Tauri app
and re-exports everything here.

The design and its vocabulary are in the
[Design Explanation](./docs/Design%20Explanation.md).

## Main exports

| Export                                    | What it is                                                                                            |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `Unit`                                    | Work `UnitRunner` can run, with its own `Detail` type.                                                |
| `RunContext<D>`                           | What a run is handed: `shutdown_token()`, `announce_running()`, `set_detail()`.                       |
| `RunPolicy`                               | `Off`, `WhileOpen`, `Until { at }` or `Always`; serde as `{"kind":"until","at":"…"}`.                 |
| `UnitId`                                  | The app's key for a unit.                                                                             |
| `UnitStatus<D>`, `RunState`, `RunStop`    | What `UnitRunner` reports for a unit.                                                                 |
| `StopReason`, `PlatformStopReason`        | Why a run stopped, and why the platform ended the background session.                                 |
| `UnitRunner<D>`                           | Holds the units and runs them, free of any platform. A host binds it; an app uses its host's binding. |
| `BackgroundSessionPlatform`               | The port a host implements to request the background session's start and end.                         |
| `WallClock`, `SystemClock`                | The wall clock policies are judged on, and the system's.                                              |
| `SessionId`                               | One background session, as the host reports its start and end.                                        |
| `RESTART_DELAY`, `WHILE_OPEN_GRACE`, etc. | The fixed timings.                                                                                    |

## Use

A domain crate defines its units and stores their policies with this crate
alone:

```rust,ignore
use unit_runner::{RunContext, RunPolicy, Unit};

pub struct Sync;

impl Unit for Sync {
    type Detail = String;

    async fn run(self, ctx: RunContext<String>) -> anyhow::Result<()> {
        ctx.announce_running();
        ctx.set_detail("connected".to_owned());
        ctx.shutdown_token().cancelled().await;
        Ok(())
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct SyncRecord {
    pub policy: RunPolicy,
}
```

The app's Tauri crate hands the units to `tauri_unit_runner::TauriUnitRunner`. A
test, or another host, drives `UnitRunner` directly:

```rust,ignore
use std::sync::Arc;
use unit_runner::{RunPolicy, SystemClock, UnitId, UnitRunner};

let runner = UnitRunner::<String>::new(tokio::runtime::Handle::current(), Arc::new(SystemClock));
runner.set_unit(UnitId::from("sync"), RunPolicy::Always, || Ok(Sync));
runner.set_app_present(true);
```
