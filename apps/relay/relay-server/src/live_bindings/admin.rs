//! [`AdminCapability`] and the [`Admin`] extractor — the admin-signature
//! gate every admin handler acquires its capability through.
//!
//! scope-capabilities-rust's `FixedScopeCapability` / `Scoped` can't be
//! reused: they read OAuth scope claims and refuse with a `403`
//! `insufficient_scope` JSON body (or a `500` when no claims were inserted),
//! while the relay's admin API gates on who signed the request and refuses
//! with a bare `401`, carrying no detail. This is the same shape with that
//! gate: the trait builds a capability from the router state, and the
//! extractor builds it only when [`require_signature`] recorded
//! [`SignedBy::Admin`].
//!
//! [`require_signature`]: crate::site::signature::require_signature

use std::ops::Deref;

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::http::StatusCode;

use crate::site::signature::SignedBy;

/// A capability the admin signature unlocks, built from the router state.
pub(crate) trait AdminCapability: Sized {
    /// The router state the capability is lifted from.
    type State: Clone + Send + Sync + 'static;

    fn build(state: Self::State) -> Self;
}

/// Extracts `F` for a request signed with `keyid="admin"`. A request signed
/// by a tunnel, or not behind [`require_signature`] at all, is a bare `401`.
/// It extracts from the request parts, so as a handler's first argument it
/// runs before the body is read.
///
/// [`require_signature`]: crate::site::signature::require_signature
pub(crate) struct Admin<F>(pub F);

impl<F> Deref for Admin<F> {
    type Target = F;

    fn deref(&self) -> &F {
        &self.0
    }
}

impl<F: AdminCapability> FromRequestParts<F::State> for Admin<F> {
    type Rejection = StatusCode;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &F::State,
    ) -> Result<Self, Self::Rejection> {
        match parts.extensions.get::<SignedBy>() {
            Some(SignedBy::Admin) => Ok(Self(F::build(state.clone()))),
            Some(SignedBy::Tunnel(_)) | None => Err(StatusCode::UNAUTHORIZED),
        }
    }
}

#[cfg(test)]
mod tests {
    use axum::http::Request;

    use super::*;

    struct Built;

    impl AdminCapability for Built {
        type State = ();

        fn build((): ()) -> Self {
            Built
        }
    }

    async fn extract(signed_by: Option<SignedBy>) -> Result<Admin<Built>, StatusCode> {
        let (mut parts, ()) = Request::new(()).into_parts();
        if let Some(signed_by) = signed_by {
            parts.extensions.insert(signed_by);
        }
        Admin::<Built>::from_request_parts(&mut parts, &()).await
    }

    #[tokio::test]
    async fn only_the_admin_signature_builds_the_capability() {
        assert!(extract(Some(SignedBy::Admin)).await.is_ok());
        for signed_by in [
            Some(SignedBy::Tunnel(
                rathole_settings_rust::TunnelName::parse("alice").unwrap(),
            )),
            None,
        ] {
            let rejection = extract(signed_by).await.err();
            assert_eq!(rejection, Some(StatusCode::UNAUTHORIZED));
        }
    }
}
