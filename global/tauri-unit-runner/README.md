# tauri-unit-runner

Runs a Tauri app's long-lived background work as **units**. Each unit has a
**run policy**. `TauriUnitRunner` starts and stops units to match their
policies, restarts the ones that end on their own, keeps the app alive in the
background with one `tauri-plugin-background-service` task for all of them, and
reports each unit's status. It knows nothing about what a unit does: the app
supplies the units, stores their policies, and owns its own wire and
notifications.

A unit whose runs keep failing restarts after `RESTART_DELAY` (5 s), then
twice as long each time in a row, up to `MAX_RESTART_DELAY` (5 minutes). A run
that announces running, `set_unit`, `set_unit_policy`, and a return to the
foreground that restarts the unit's run in progress start the delay over. A
unit already waiting out its delay keeps waiting through a return to the
foreground.

This crate is the Tauri bindings of [`unit-runner`](../unit-runner/README.md),
which holds the units, policies, statuses, and starting and stopping runs per
policy, free of Tauri. It
re-exports every public type of `unit-runner`, so an app needs only this
crate, while its domain crates depend on `unit-runner` alone.

The design and its vocabulary are in `unit-runner`'s
[Design Explanation](../unit-runner/docs/Design%20Explanation.md), and the
Tauri side in this crate's [Design Explanation](./docs/Design%20Explanation.md).

## Main exports

| Export                                       | What it is                                                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `TauriUnitRunner<D>`                         | Holds the app's units. `set_unit`, `set_unit_policy`, `remove_unit`, `statuses`, `subscribe`, and the two plugins below. |
| `TauriUnitRunner::background_service_plugin` | `tauri-plugin-background-service` with `TauriUnitRunner`'s background session as its one service.                        |
| `TauriUnitRunner::lifecycle_plugin`          | Follows the app's windows and its returns to the foreground, and starts and ends the background session.                 |
| `Unit`                                       | Work `TauriUnitRunner` can run, with its own `Detail` type.                                                              |
| `RunContext<D>`                              | What a run is handed: `shutdown_token()`, `announce_running()`, `set_detail()`.                                          |
| `RunPolicy`                                  | `Off`, `WhileOpen`, `Until { at }` or `Always`; serde as `{"kind":"until","at":"…"}`.                                    |
| `UnitId`                                     | The app's key for a unit.                                                                                                |
| `UnitStatus<D>`, `RunState`, `RunStop`       | What `TauriUnitRunner` reports for a unit.                                                                               |
| `StopReason`, `PlatformStopReason`           | Why a run stopped, and why the platform ended the background session.                                                    |
| `BackgroundServiceStartConfig`               | The plugin's start config (Android notification label and service type), re-exported.                                    |
| `RESTART_DELAY`, `WHILE_OPEN_GRACE`, etc.    | The fixed timings.                                                                                                       |
| `unit-runner`'s other exports                | `UnitRunner`, `BackgroundSessionPlatform`, `WallClock` and the rest, re-exported.                                        |

## Use

```rust,ignore
use tauri_unit_runner::{
    BackgroundServiceStartConfig, RunContext, RunPolicy, TauriUnitRunner, Unit, UnitId,
};

struct Sync;

impl Unit for Sync {
    type Detail = String;

    async fn run(self, ctx: RunContext<String>) -> anyhow::Result<()> {
        ctx.announce_running();
        ctx.set_detail("connected".to_owned());
        ctx.shutdown_token().cancelled().await;
        Ok(())
    }
}

let runner = TauriUnitRunner::<String>::new(BackgroundServiceStartConfig {
    service_label: "Syncing in the background".to_owned(),
    foreground_service_type: "dataSync".to_owned(),
});
tauri::Builder::default()
    .plugin(tauri_plugin_notification::init())
    .plugin(runner.background_service_plugin())
    .plugin(runner.lifecycle_plugin())
    .setup(move |_app| {
        runner.set_unit(UnitId::from("sync"), RunPolicy::WhileOpen, || Ok(Sync));
        Ok(())
    });
```

The app also configures the background-service plugin as its platforms need:
`plugins.background-service` in `tauri.conf.json`, the Android manifest, and
the iOS background modes.
