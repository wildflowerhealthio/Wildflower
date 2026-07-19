//! [`RemoteError`] — the collector domain's failure vocabulary the HTTP layer
//! renders.

/// The ways a remotes operation can fail — the domain's failure vocabulary. The
/// first three are **semantic**, client-facing outcomes that are part of the
/// wire contract; [`Infrastructure`](RemoteError::Infrastructure) is an opaque
/// infrastructure failure. The HTTP layer ([`crate::http::errors`]) renders each
/// to a status and wire body (or a logged opaque 500 for `Infrastructure`);
/// nothing here knows about HTTP, and the store ([`crate::db`]) produces
/// `Infrastructure` without leaking its db/`anyhow` types up to the routes. The
/// semantic outcomes are decided in [`crate::domain::capabilities`], which map
/// the store's primitive absence/conflict signals onto `NotFound` /
/// `AlreadyExists`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoteError {
    /// No remote has this id (a read / update / delete addressed an unknown id).
    NotFound { id: String },
    /// The submitted config carries no string `_tag`, so the denormalized `tag`
    /// (column + wire field) can't be produced.
    InvalidConfig { message: String },
    /// A create used a client-minted id that's already taken.
    AlreadyExists { id: String },
    /// The caller authenticated but their token doesn't cover the
    /// `wildflower/Accounts.<perm>` scope the operation requires — the
    /// authorization (not authentication) failure the HTTP layer renders as the
    /// shared `403 InsufficientScope` body. `missing_scopes` names the
    /// (already-rendered) scopes the caller must additionally hold.
    ///
    /// The scope-gated handlers acquire a
    /// [`Scoped`](scope_capabilities_rust::Scoped) capability whose extractor
    /// produces this `403` directly, so this variant is part of the failure
    /// *vocabulary* the HTTP layer models uniformly (and the OpenAPI `403`
    /// documents) rather than one the handler bodies construct.
    InsufficientScope { missing_scopes: Vec<String> },
    /// An infrastructure failure in the backing store (a checkout or query
    /// error) — opaque to clients: the HTTP layer logs `context` + `source` and
    /// answers an empty 500. The cause is captured as text so this type stays
    /// free of the store's db/`anyhow` error types.
    Infrastructure {
        context: &'static str,
        source: String,
    },
}

impl RemoteError {
    /// Wrap an infrastructure failure (a store checkout or query error) as an
    /// opaque [`Infrastructure`](RemoteError::Infrastructure), capturing
    /// `context` and the cause's `Display` text. The store calls this so its
    /// db/`anyhow` error types never reach the HTTP layer.
    #[must_use]
    pub fn infrastructure(context: &'static str, source: impl std::fmt::Display) -> Self {
        RemoteError::Infrastructure {
            context,
            source: source.to_string(),
        }
    }
}
