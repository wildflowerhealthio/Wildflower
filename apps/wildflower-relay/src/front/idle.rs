//! The idle timeout for a piped connection.
//!
//! Both sides of a pipe are wrapped in [`Tracked`], which notes the time
//! whenever a read returns bytes. [`Activity::idle`] resolves once neither
//! side has delivered anything for the timeout, and the pipe is then closed.

use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;
use tokio::time::Instant;

/// When either side of a pipe last delivered bytes.
pub(super) struct Activity {
    start: Instant,
    /// Milliseconds after `start` of the last read that returned bytes.
    last_millis: AtomicU64,
}

impl Activity {
    pub(super) fn new() -> Self {
        Self {
            start: Instant::now(),
            last_millis: AtomicU64::new(0),
        }
    }

    fn touch(&self) {
        let now = u64::try_from(self.start.elapsed().as_millis()).unwrap_or(u64::MAX);
        self.last_millis.store(now, Ordering::Relaxed);
    }

    fn idle_for(&self) -> Duration {
        let last = Duration::from_millis(self.last_millis.load(Ordering::Relaxed));
        self.start.elapsed().saturating_sub(last)
    }

    /// Resolve once nothing has moved for `timeout`.
    pub(super) async fn idle(&self, timeout: Duration) {
        loop {
            let idle = self.idle_for();
            if idle >= timeout {
                return;
            }
            tokio::time::sleep(timeout - idle).await;
        }
    }
}

/// A [`TcpStream`] that records every read returning bytes into a shared
/// [`Activity`]. Writes pass straight through.
pub(super) struct Tracked {
    inner: TcpStream,
    activity: Arc<Activity>,
}

impl Tracked {
    pub(super) fn new(inner: TcpStream, activity: Arc<Activity>) -> Self {
        Self { inner, activity }
    }
}

impl AsyncRead for Tracked {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let before = buf.filled().len();
        let poll = Pin::new(&mut self.inner).poll_read(cx, buf);
        if matches!(poll, Poll::Ready(Ok(()))) && buf.filled().len() > before {
            self.activity.touch();
        }
        poll
    }
}

impl AsyncWrite for Tracked {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn idle_waits_for_the_timeout_after_the_last_touch() {
        let activity = Activity::new();
        tokio::time::sleep(Duration::from_millis(50)).await;
        activity.touch();
        let started = Instant::now();
        activity.idle(Duration::from_millis(100)).await;
        // `touch` rounds down to the millisecond, so allow a little slack.
        assert!(started.elapsed() >= Duration::from_millis(95));
    }
}
