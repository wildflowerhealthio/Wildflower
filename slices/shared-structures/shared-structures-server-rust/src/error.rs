//! The crate's typed error — distinguishes the two failure scopes the server
//! infra can hit so a caller can react to each differently.

/// A failure from [`StaticHostsService`](crate::StaticHostsService) or
/// [`ProxyTable`](crate::ProxyTable).
///
/// The two variants are deliberately distinct *scopes*:
/// - [`Bind`](ServerError::Bind) is recoverable and expected — a port was
///   already taken. A caller can log it and still register the host for
///   reverse-proxy dispatch (remote traffic routes once something serves the
///   port).
/// - [`LockPoisoned`](ServerError::LockPoisoned) is an internal invariant
///   violation — a thread panicked while holding a shared lock. Unlikely, but
///   surfaced rather than papered over with a panic of our own.
#[derive(Debug, thiserror::Error)]
pub enum ServerError {
    /// A static host's loopback listener failed to bind (typically the port is
    /// already in use).
    #[error("failed to bind loopback listener on {addr}")]
    Bind {
        addr: String,
        #[source]
        source: std::io::Error,
    },
    /// A shared lock was poisoned by a panic in another thread holding it.
    #[error("{resource} lock poisoned")]
    LockPoisoned { resource: &'static str },
}

impl ServerError {
    /// `ServerError::LockPoisoned` for `resource` — used to map a poisoned
    /// `std::sync` lock guard into a typed error instead of panicking.
    pub(crate) fn lock(resource: &'static str) -> Self {
        Self::LockPoisoned { resource }
    }
}
