//! [`Live<F>`] — the extractor for the capabilities that no principal unlocks
//! (the pre-auth front door's public and client-gated ones, whose real gate is
//! the proof their methods take). It is how a handler obtains a capability
//! without naming the router state: the source guard forbids `State<…>` in
//! handler files, so the only way to reach the store from a handler is one of
//! the capability extractors.

use std::ops::Deref;
use std::sync::Arc;

use axum::extract::FromRequestParts;
use axum::http::request::Parts;

use crate::http::state::GatekeeperState;
use crate::live_bindings::FromState;

/// A capability built from the router state alone. Derefs to `F`.
pub(crate) struct Live<F: FromState>(pub(crate) F);

impl<F: FromState> Deref for Live<F> {
    type Target = F;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl<F: FromState> FromRequestParts<Arc<GatekeeperState>> for Live<F> {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(
        _parts: &mut Parts,
        state: &Arc<GatekeeperState>,
    ) -> Result<Self, Self::Rejection> {
        Ok(Live(F::from_state(state)))
    }
}
