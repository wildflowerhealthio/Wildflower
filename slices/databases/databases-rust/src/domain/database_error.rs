//! [`DatabaseError`] — the databases domain's failure vocabulary the HTTP layer
//! renders.

/// The ways a databases operation can fail — the domain's failure vocabulary.
/// [`NotFound`](DatabaseError::NotFound) is a **semantic**, client-facing
/// outcome that is part of the wire contract;
/// [`Infrastructure`](DatabaseError::Infrastructure) is an opaque infrastructure
/// failure. The HTTP layer
/// ([`crate::http::errors`]) renders each to a status and wire body (or a logged
/// opaque 500 for `Infrastructure`); nothing here knows about HTTP, and the file
/// layer ([`crate::files`]) produces `Infrastructure` without leaking its
/// rusqlite/`io` error types up to the routes.
#[derive(Debug)]
pub enum DatabaseError {
    /// No catalogued database has this id, or it isn't present on disk — a
    /// read / download / delete addressed an unknown or absent database.
    NotFound { id: String },
    /// An infrastructure failure in a file-level operation (a snapshot export or
    /// a marker write) — opaque to clients: the HTTP layer logs `context` +
    /// `source` and answers an empty 500. The cause is captured as text so this
    /// type stays free of the file layer's rusqlite/`io` error types.
    Infrastructure {
        context: &'static str,
        source: String,
    },
}

impl DatabaseError {
    /// Wrap an infrastructure failure (a snapshot export or marker write error)
    /// as an opaque [`Infrastructure`](DatabaseError::Infrastructure), capturing
    /// `context` and the cause's `Display` text. The file layer calls this so its
    /// rusqlite/`io` error types never reach the HTTP layer.
    #[must_use]
    pub fn infrastructure(context: &'static str, source: impl std::fmt::Display) -> Self {
        DatabaseError::Infrastructure {
            context,
            source: source.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// [`infrastructure`](DatabaseError::infrastructure) keeps `context` verbatim
    /// and captures the cause's `Display` text, so the file layer's error types
    /// never travel up to the HTTP layer as anything but a string.
    #[test]
    fn infrastructure_captures_context_and_the_cause_display_text() {
        let error = DatabaseError::infrastructure(
            "VACUUM INTO snapshot",
            std::io::Error::new(std::io::ErrorKind::PermissionDenied, "disk full"),
        );
        let DatabaseError::Infrastructure { context, source } = error else {
            panic!("expected an Infrastructure variant");
        };
        assert_eq!(context, "VACUUM INTO snapshot");
        assert_eq!(source, "disk full");
    }
}
