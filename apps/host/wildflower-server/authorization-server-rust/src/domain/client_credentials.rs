//! [`ClientCredentials`] — the `client_id` / `client_secret` pair an OAuth
//! client presents (RFC 6749 §2.3.1), as the domain sees it: which client, and
//! the secret it claims. *How* the pair arrived (Basic header or form body) is
//! a transport fact that stays in the HTTP layer.

use zeroize::{Zeroize, ZeroizeOnDrop};

/// A client's presented credentials. The plaintext `client_secret` is scrubbed
/// from memory when the value is dropped (`ZeroizeOnDrop`) — defense in depth
/// that shortens the window the secret sits on the heap after the request that
/// verified it completes; it does not eliminate every copy (the raw request
/// body and header still live in axum's buffers upstream). `client_id` is not
/// secret and is skipped.
#[derive(PartialEq, Eq, Zeroize, ZeroizeOnDrop)]
pub struct ClientCredentials {
    /// The client the caller says it is. Not secret, so not scrubbed.
    #[zeroize(skip)]
    pub client_id: String,
    /// The plaintext secret a confidential client authenticates with; `None`
    /// for a public client, which has none.
    pub client_secret: Option<String>,
}

/// Debug output with `client_secret` redacted.
impl std::fmt::Debug for ClientCredentials {
    /// Format the credentials with `client_secret` redacted, so the plaintext
    /// scrubbed on drop can't leak through a log line or a `{:?}` in a
    /// test-failure message. Only the secret's presence is shown, never its
    /// value.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClientCredentials")
            .field("client_id", &self.client_id)
            .field(
                "client_secret",
                &self.client_secret.as_ref().map(|_| "<redacted>"),
            )
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A formatted credential shows the client and a redaction marker, never
    /// the secret's value.
    #[test]
    fn debug_redacts_client_secret() {
        let credentials = ClientCredentials {
            client_id: "app".to_string(),
            client_secret: Some("SUPER-SECRET-VALUE".to_string()),
        };
        let rendered = format!("{credentials:?}");
        // The secret value must never surface in a formatted credential.
        assert!(
            !rendered.contains("SUPER-SECRET-VALUE"),
            "secret leaked: {rendered}"
        );
        // Presence of a secret is still shown so the value stays diagnosable.
        assert!(
            rendered.contains("<redacted>"),
            "no redaction marker: {rendered}"
        );
        assert!(rendered.contains("app"), "client_id hidden: {rendered}");
    }

    /// A credential with no secret formats it as `None`, not as redacted.
    #[test]
    fn debug_shows_absent_client_secret_as_none() {
        let credentials = ClientCredentials {
            client_id: "app".to_string(),
            client_secret: None,
        };
        let rendered = format!("{credentials:?}");
        // A missing secret reads as `None`, distinct from a redacted present one.
        assert!(
            rendered.contains("None"),
            "absent secret not shown: {rendered}"
        );
        assert!(
            !rendered.contains("<redacted>"),
            "redaction marker on absent secret: {rendered}"
        );
    }
}
