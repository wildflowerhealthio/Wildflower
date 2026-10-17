//! The relay's two logs, and the pruning that keeps the second one short.
//!
//! - **The journal**: stdout, which systemd keeps in its journal for as long
//!   as it keeps anything. It names no one: no tunnel names, SNI, IP
//!   addresses, emails or claim codes. The relay's own domain and hostnames,
//!   which are the operator's settings, may appear.
//! - **The connection log**: `<state dir>/connection-log/`, one file per UTC
//!   hour (`connection.2026-10-16-13.log`), each deleted 24 hours after its
//!   last entry. It holds only the events that need an identifier: those
//!   logged with `target: IDENTIFYING`, which name a tunnel (or, for a
//!   rate-limited claim, a client's address), and every event of rathole's
//!   (`rathole::…`), which puts each device's IP address in its
//!   `connection` span and names tunnels in its messages.
//!
//! `RUST_LOG` (default `info`) sets the level for both. An event goes to
//! exactly one of them.

use std::env::VarError;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use anyhow::Context;
use tokio::sync::broadcast;
use tracing::level_filters::LevelFilter;
use tracing::{Metadata, Subscriber};
use tracing_appender::non_blocking::WorkerGuard;
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::filter::{filter_fn, FilterExt};
use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{EnvFilter, Layer};

/// The target of an event that names someone: it goes to the connection log
/// and never to the journal. `tracing::info!(target: IDENTIFYING, tunnel =
/// %name, "…")`.
pub const IDENTIFYING: &str = "relay::identifying";

/// The connection log's directory, under the state directory.
pub const CONNECTION_LOG_DIR: &str = "connection-log";

/// How long a connection log file is kept after its last entry.
pub const CONNECTION_LOG_RETENTION: Duration = Duration::from_secs(24 * 3600);

/// How often the connection log is pruned, after once at start.
const PRUNE_INTERVAL: Duration = Duration::from_secs(10 * 60);

/// Each hour's file is `connection.<UTC date and hour>.log`.
const FILE_PREFIX: &str = "connection";
const FILE_SUFFIX: &str = "log";

/// `<state_dir>/connection-log`.
#[must_use]
pub fn connection_log_dir(state_dir: &Path) -> PathBuf {
    state_dir.join(CONNECTION_LOG_DIR)
}

/// Whether an event or span with `metadata` belongs in the connection log
/// rather than the journal.
fn names_someone(metadata: &Metadata<'_>) -> bool {
    let target = metadata.target();
    target == IDENTIFYING || target == "rathole" || target.starts_with("rathole::")
}

/// `RUST_LOG`'s directives, `info` where it sets none. A directive that does
/// not parse is left out, as `tracing_subscriber`'s own `RUST_LOG` reading
/// does.
fn env_filter(rust_log: &str) -> EnvFilter {
    EnvFilter::builder()
        .with_default_directive(LevelFilter::INFO.into())
        .parse_lossy(rust_log)
}

/// The two layers, filtered by `rust_log`'s directives: the journal's,
/// writing to `journal` every event that names no one, and the connection
/// log's, writing to `connection_log` the rest. Both use the same format.
pub fn layers<S, J, C>(rust_log: &str, journal: J, connection_log: C) -> impl Layer<S>
where
    S: Subscriber + for<'span> LookupSpan<'span>,
    J: for<'writer> MakeWriter<'writer> + Send + Sync + 'static,
    C: for<'writer> MakeWriter<'writer> + Send + Sync + 'static,
{
    let journal_layer = tracing_subscriber::fmt::layer()
        .with_writer(journal)
        .with_filter(env_filter(rust_log).and(filter_fn(|metadata| !names_someone(metadata))));
    let connection_log_layer = tracing_subscriber::fmt::layer()
        .with_writer(connection_log)
        .with_ansi(false)
        .with_filter(env_filter(rust_log).and(filter_fn(names_someone)));
    journal_layer.and_then(connection_log_layer)
}

/// Create the connection log's directory under `state_dir` (and the state
/// directory, if missing), readable by the owner only, and install the two
/// layers as the global subscriber, filtered by `RUST_LOG`. The connection
/// log is written from a background thread; hold the returned guard until
/// exit, so the lines still queued are written.
///
/// # Errors
///
/// Returns an error if the directory or the first file cannot be created,
/// `RUST_LOG` is not Unicode, or a global subscriber is already installed.
pub fn init(state_dir: &Path) -> anyhow::Result<WorkerGuard> {
    let dir = connection_log_dir(state_dir);
    crate::create_state_dir(&dir).with_context(|| format!("creating {}", dir.display()))?;
    let appender = RollingFileAppender::builder()
        .rotation(Rotation::HOURLY)
        .filename_prefix(FILE_PREFIX)
        .filename_suffix(FILE_SUFFIX)
        .build(&dir)
        .with_context(|| format!("opening the connection log in {}", dir.display()))?;
    let (connection_log, guard) = tracing_appender::non_blocking(appender);
    let rust_log = match std::env::var("RUST_LOG") {
        Ok(rust_log) => rust_log,
        Err(VarError::NotPresent) => String::new(),
        Err(e) => return Err(e).context("reading RUST_LOG"),
    };
    tracing_subscriber::registry()
        .with(layers(&rust_log, std::io::stdout, connection_log))
        .try_init()
        .context("installing the relay's logging")?;
    Ok(guard)
}

/// Delete the connection log's old files in `dir` (see
/// `prune_connection_log_files`) at once and then every ten minutes, until
/// `shutdown_rx` fires. A failure is logged to the journal and retried next
/// time.
///
/// # Errors
///
/// Currently never; the `Result` keeps the signature in line with the other
/// relay tasks it is joined with.
pub async fn prune_connection_log(
    dir: PathBuf,
    mut shutdown_rx: broadcast::Receiver<bool>,
) -> anyhow::Result<()> {
    // The first tick is at once.
    let mut interval = tokio::time::interval(PRUNE_INTERVAL);
    loop {
        tokio::select! {
            _ = interval.tick() => {}
            _ = shutdown_rx.recv() => return Ok(()),
        }
        let dir = dir.clone();
        let pruned = tokio::task::spawn_blocking(move || {
            prune_connection_log_files(&dir, SystemTime::now() - CONNECTION_LOG_RETENTION)
        })
        .await;
        match pruned {
            Ok(Ok(())) => {}
            Ok(Err(e)) => tracing::warn!("pruning the connection log failed: {e}"),
            Err(e) => tracing::warn!("pruning the connection log panicked: {e}"),
        }
    }
}

/// Delete each connection log file in `dir` last modified before `cutoff`.
/// Nothing else in `dir` is touched. A file that cannot be deleted is
/// logged to the journal and skipped.
///
/// # Errors
///
/// Returns an error if `dir` cannot be read.
fn prune_connection_log_files(dir: &Path, cutoff: SystemTime) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let pruned = entry.and_then(|entry| {
            let is_log_file = entry
                .file_name()
                .to_str()
                .is_some_and(is_connection_log_file);
            let metadata = entry.metadata()?;
            if is_log_file && metadata.is_file() && metadata.modified()? < cutoff {
                fs::remove_file(entry.path())?;
            }
            Ok(())
        });
        if let Err(e) = pruned {
            tracing::warn!("pruning a connection log file failed: {e}");
        }
    }
    Ok(())
}

/// Whether `file_name` is one of the connection log's hourly files,
/// `connection.<…>.log`.
fn is_connection_log_file(file_name: &str) -> bool {
    file_name
        .strip_prefix(FILE_PREFIX)
        .and_then(|rest| rest.strip_prefix('.'))
        .and_then(|rest| rest.strip_suffix(FILE_SUFFIX))
        .and_then(|rest| rest.strip_suffix('.'))
        .is_some_and(|hour| !hour.is_empty())
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex, PoisonError};

    use tracing_subscriber::layer::SubscriberExt;

    use super::*;

    /// Lines a layer writes, kept in memory.
    #[derive(Clone, Default)]
    struct Captured(Arc<Mutex<Vec<u8>>>);

    impl Captured {
        fn text(&self) -> String {
            let bytes = self.0.lock().unwrap_or_else(PoisonError::into_inner);
            String::from_utf8_lossy(&bytes).into_owned()
        }
    }

    impl io::Write for Captured {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl<'writer> MakeWriter<'writer> for Captured {
        type Writer = Self;

        fn make_writer(&'writer self) -> Self {
            self.clone()
        }
    }

    #[test]
    fn the_journal_gets_what_names_no_one_and_the_connection_log_the_rest() {
        let (journal, connection_log) = (Captured::default(), Captured::default());
        let subscriber = tracing_subscriber::registry().with(layers(
            "info",
            journal.clone(),
            connection_log.clone(),
        ));
        tracing::subscriber::with_default(subscriber, || {
            tracing::info!(target: IDENTIFYING, tunnel = "alice", "identifying line");
            tracing::info!(target: "rathole::server", "rathole line");
            tracing::info!(target: "rathole", "rathole root line");
            tracing::info!(target: "ratholes", "lookalike line");
            tracing::info!("relay line");
            tracing::debug!(target: IDENTIFYING, "below the level");
        });

        let (journal, connection_log) = (journal.text(), connection_log.text());
        for line in ["relay line", "lookalike line"] {
            assert!(journal.contains(line), "{journal}");
            assert!(!connection_log.contains(line), "{connection_log}");
        }
        for line in ["identifying line", "rathole line", "rathole root line"] {
            assert!(connection_log.contains(line), "{connection_log}");
            assert!(!journal.contains(line), "{journal}");
        }
        assert!(!journal.contains("alice"), "{journal}");
        assert!(
            !format!("{journal}{connection_log}").contains("below the level"),
            "RUST_LOG filters both"
        );
    }

    #[test]
    fn rathole_spans_stay_out_of_the_journal() {
        let (journal, connection_log) = (Captured::default(), Captured::default());
        let subscriber = tracing_subscriber::registry().with(layers(
            "info",
            journal.clone(),
            connection_log.clone(),
        ));
        tracing::subscriber::with_default(subscriber, || {
            let span = tracing::info_span!(target: "rathole::server", "connection", addr = "192.0.2.7:1234");
            let _entered = span.enter();
            tracing::info!(target: "rathole::server", "control channel up");
        });
        assert!(connection_log.text().contains("192.0.2.7"));
        assert!(!journal.text().contains("192.0.2.7"));
    }

    #[test]
    fn only_hourly_files_older_than_the_cutoff_are_pruned() {
        let dir = tempfile::tempdir().unwrap();
        let now = SystemTime::now();
        let hours_ago = |hours: u64| now - Duration::from_secs(hours * 3600);
        for (name, modified) in [
            ("connection.2026-10-15-12.log", hours_ago(25)),
            ("connection.2026-10-15-14.log", hours_ago(23)),
            ("connection.log", hours_ago(25)),
            ("other.2026-10-15-12.log", hours_ago(25)),
            ("tunnels.db", hours_ago(25)),
        ] {
            let file = fs::File::create(dir.path().join(name)).unwrap();
            file.set_modified(modified).unwrap();
        }

        prune_connection_log_files(dir.path(), now - CONNECTION_LOG_RETENTION).unwrap();

        let mut left: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        left.sort();
        assert_eq!(
            left,
            [
                "connection.2026-10-15-14.log",
                "connection.log",
                "other.2026-10-15-12.log",
                "tunnels.db",
            ]
        );
    }
}
