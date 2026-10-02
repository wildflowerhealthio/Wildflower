//! The Android headless-core shim: the JNI functions
//! `tauri-plugin-background-service`'s `HeadlessBridge` calls in the host's
//! library, and the flag that tells them whether this process runs the
//! server's host. See the
//! [Design Explanation](../../docs/Design%20Explanation.md).
//!
//! On Android the plugin's foreground service (`LifecycleService`) starts a
//! "headless core" through `HeadlessBridge.startCore` before it reports the
//! service as started, and stops the service when that fails. This app has no
//! headless core: the server runs in the Tauri host's `BackgroundService`. So
//! `startCore` reports success only once the host has marked itself running
//! ([`mark_host_running`]), and refuses a start Android makes on its own with
//! no host in the process, so the plugin's failure handling runs rather than a
//! "running" notification with nothing behind it.
//!
//! The shim is removed once the plugin can run without a native core (#886).

mod headless_core_report;
mod jni_exports;

use std::sync::atomic::{AtomicBool, Ordering};

/// Whether this process's Tauri host has set up the server and starts it
/// through the background service. Process-global because the JNI exports are
/// called from the plugin's Kotlin, with no handle to the host; set once and
/// never cleared, since the host lives as long as the process.
static HOST_RUNNING: AtomicBool = AtomicBool::new(false);

/// Records that this process's Tauri host runs the server, so the plugin's
/// foreground service may report itself started.
///
/// The host calls this in `.setup()`, after publishing the server's context
/// and before starting the service. Until then `HeadlessBridge.startCore`
/// refuses with `host_not_running`.
pub fn mark_host_running() {
    HOST_RUNNING.store(true, Ordering::Release);
}

/// Whether [`mark_host_running`] has run in this process.
fn host_is_running() -> bool {
    HOST_RUNNING.load(Ordering::Acquire)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The only test that touches the process-global flag, so no other test
    /// can have set it first.
    #[test]
    fn marking_the_host_running_is_what_host_is_running_reads() {
        assert!(!host_is_running());
        mark_host_running();
        assert!(host_is_running());
    }

    /// Reads a `Cargo.toml` relative to this crate.
    fn read_manifest(relative: &str) -> toml::Table {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(relative);
        std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {error}", path.display()))
            .parse()
            .unwrap_or_else(|error| panic!("{} is not TOML: {error}", path.display()))
    }

    /// This crate's `[lints]` is the workspace's with `unsafe_code` lowered
    /// from `forbid` to `deny`, so the exports can allow it and nothing else
    /// drifts from the workspace.
    #[test]
    fn the_lints_are_the_workspace_s_with_unsafe_code_denied() {
        let workspace_lints = read_manifest("../../../Cargo.toml")["workspace"]["lints"].clone();
        let mut expected_lints = workspace_lints
            .as_table()
            .expect("[workspace.lints] is a table")
            .clone();
        let rust_lints = expected_lints
            .get_mut("rust")
            .and_then(toml::Value::as_table_mut)
            .expect("[workspace.lints.rust] is a table");
        assert_eq!(
            rust_lints.get("unsafe_code").and_then(toml::Value::as_str),
            Some("forbid")
        );
        rust_lints.insert("unsafe_code".to_owned(), "deny".into());

        let crate_lints = read_manifest("Cargo.toml")["lints"].clone();
        assert_eq!(crate_lints, toml::Value::Table(expected_lints));
    }
}
