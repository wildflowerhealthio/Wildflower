//! The OS thread and tokio runtime each run happens on, and the bounded
//! shutdown of that runtime once the unit's run returns.

use std::panic::AssertUnwindSafe;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context};
use tokio::sync::oneshot;

use super::erased_unit::UnitFactory;
use crate::run_context::RunContext;

/// How long a run's runtime waits for the tasks its unit spawned, once the
/// unit's run has returned, before the thread gives up on them. A runtime that
/// is dropped instead waits forever on blocking work still in flight.
pub const RUN_RUNTIME_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

/// Build a fresh unit with `factory` and run it with `ctx` on a new OS thread
/// with its own multi-thread runtime, and wait for the result.
///
/// When the unit's run returns, the thread shuts the runtime down, giving the
/// unit's tasks `shutdown_timeout` to finish, which cancels every task the unit
/// spawned. Only then does this return.
///
/// # Errors
///
/// The factory's or the unit's error, or the panic either died with.
pub(crate) async fn run_on_dedicated_thread<D: Clone + Send + Sync + 'static>(
    factory: UnitFactory<D>,
    ctx: RunContext<D>,
    shutdown_timeout: Duration,
) -> anyhow::Result<()> {
    // Should this future be dropped rather than awaited to the end, the unit
    // still stops.
    let _stop_unit_when_dropped = ctx.shutdown_token().clone().drop_guard();
    let (result_tx, result_rx) = oneshot::channel();
    let thread_name = format!("unit-{}", ctx.unit_id());
    std::thread::Builder::new()
        .name(thread_name.clone())
        .spawn(move || {
            let result = run_on_dedicated_runtime(&thread_name, &factory, ctx, shutdown_timeout);
            if result_tx.send(result).is_err() {
                log::debug!("[unit-runner] {thread_name}: its run is no longer waiting for it");
            }
        })
        .context("failed to spawn the unit's thread")?;
    result_rx
        .await
        .context("the unit's thread ended without reporting a result")?
}

/// The body of the run's thread: build a runtime, build and run the unit on
/// it, then shut it down.
fn run_on_dedicated_runtime<D: Clone + Send + Sync + 'static>(
    thread_name: &str,
    factory: &UnitFactory<D>,
    ctx: RunContext<D>,
    shutdown_timeout: Duration,
) -> anyhow::Result<()> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_name(format!("{thread_name}-worker"))
        .build()
        .context("failed to build the unit's runtime")?;
    // A panic must not skip the bounded shutdown below: an unwinding thread
    // would drop the runtime instead, which can wait on a blocking worker
    // forever and hold the unit's run gate shut.
    let ran = std::panic::catch_unwind(AssertUnwindSafe(|| {
        runtime.block_on(async move {
            let unit = factory().context("the unit's factory failed")?;
            unit.run_boxed(ctx).await
        })
    }))
    .unwrap_or_else(|panic| Err(anyhow!("the unit panicked: {}", panic_message(&*panic))));
    shut_down_runtime(thread_name, runtime, shutdown_timeout);
    ran
}

/// Shut `runtime` down, giving its tasks `shutdown_timeout` to finish, and log
/// when blocking work outlived it.
fn shut_down_runtime(
    thread_name: &str,
    runtime: tokio::runtime::Runtime,
    shutdown_timeout: Duration,
) {
    let shutdown_started = Instant::now();
    runtime.shutdown_timeout(shutdown_timeout);
    if shutdown_started.elapsed() >= shutdown_timeout {
        log::warn!(
            "[unit-runner] {thread_name}: blocking work outlived the runtime's \
             {shutdown_timeout:?} shutdown timeout and was left running"
        );
    }
}

/// The text a panic was raised with, when it was raised with text.
fn panic_message(panic: &(dyn std::any::Any + Send)) -> &str {
    if let Some(message) = panic.downcast_ref::<&str>() {
        message
    } else if let Some(message) = panic.downcast_ref::<String>() {
        message
    } else {
        "a non-text panic payload"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panic_messages_are_read_from_text_payloads() {
        let from_str = std::panic::catch_unwind(|| panic!("static text")).expect_err("panics");
        assert_eq!(panic_message(&*from_str), "static text");
        let from_string =
            std::panic::catch_unwind(|| panic!("{} text", "formatted")).expect_err("panics");
        assert_eq!(panic_message(&*from_string), "formatted text");
        let from_value =
            std::panic::catch_unwind(|| std::panic::panic_any(7_u8)).expect_err("panics");
        assert_eq!(panic_message(&*from_value), "a non-text panic payload");
    }
}
