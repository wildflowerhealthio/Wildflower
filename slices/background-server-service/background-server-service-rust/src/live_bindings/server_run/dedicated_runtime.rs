//! The dedicated OS thread and tokio runtime each server run serves on, and
//! the bounded shutdown of that runtime once the server stops.

use std::panic::AssertUnwindSafe;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use super::ServerHostContext;

/// How long a run's runtime waits for its tasks after the server stops, before
/// the thread gives up on them. Gatekeeper's retention sweep can hold a
/// blocking worker for up to 30 s on a pooled connection; a runtime that is
/// dropped instead waits for it forever.
pub const SERVER_RUNTIME_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

/// The name of each run's OS thread, and the prefix of its runtime's workers.
const SERVER_THREAD_NAME: &str = "wildflower-server";

impl ServerHostContext {
    /// Spawn the run's thread and wait for its result.
    pub(super) async fn serve_on_server_thread(
        &self,
        server_shutdown: CancellationToken,
    ) -> anyhow::Result<()> {
        // Should this future be dropped rather than cancelled, the server still
        // stops.
        let _stop_server_when_dropped = server_shutdown.clone().drop_guard();
        let (result_sender, result_receiver) = oneshot::channel();
        let context = self.clone();
        std::thread::Builder::new()
            .name(SERVER_THREAD_NAME.to_owned())
            .spawn(move || {
                let result = context.serve_on_dedicated_runtime(server_shutdown);
                if result_sender.send(result).is_err() {
                    tracing::debug!("server run result dropped: its run is no longer waiting");
                }
            })
            .context("failed to spawn the server thread")?;
        result_receiver
            .await
            .context("the server thread ended without reporting a result")?
    }

    /// The body of the run's thread: build a runtime, set up and serve on it,
    /// then shut it down.
    fn serve_on_dedicated_runtime(&self, shutdown: CancellationToken) -> anyhow::Result<()> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .thread_name(format!("{SERVER_THREAD_NAME}-worker"))
            .build()
            .context("failed to build the server runtime")?;
        // A panic in the server must not skip the bounded shutdown below: an
        // unwinding thread would drop the runtime instead, which can wait on a
        // blocking worker forever and hold the gate shut.
        let served = std::panic::catch_unwind(AssertUnwindSafe(|| {
            runtime.block_on(self.set_up_and_serve(shutdown))
        }))
        .unwrap_or_else(|panic| Err(anyhow!("the server panicked: {}", panic_message(&*panic))));
        shut_down_runtime(runtime);
        served
    }
}

/// Shut `runtime` down, giving its tasks [`SERVER_RUNTIME_SHUTDOWN_TIMEOUT`] to
/// finish, and log when blocking work outlived it.
fn shut_down_runtime(runtime: tokio::runtime::Runtime) {
    let shutdown_started = Instant::now();
    runtime.shutdown_timeout(SERVER_RUNTIME_SHUTDOWN_TIMEOUT);
    if shutdown_started.elapsed() >= SERVER_RUNTIME_SHUTDOWN_TIMEOUT {
        tracing::warn!(
            "the server runtime's blocking work outlived its {SERVER_RUNTIME_SHUTDOWN_TIMEOUT:?} \
             shutdown timeout and was left running"
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
