//! `/devices/{userCode}` routes — the Owner-facing consent prompt for the
//! device-code flow (RFC 8628). One module per route (`get`, `approve`,
//! `deny`), each exposing a `MethodRouter`; shared DTOs and the request loader
//! live in [`internal`]. `router()` is the only path table.

mod approve;
mod deny;
mod get;
mod internal;

use axum::middleware::from_fn_with_state;
use axum::Router;

use crate::http::middleware::{rate_limit_user_code, SlidingWindowRateLimiter};
use crate::http::state::AppState;

/// Build the `/devices/{userCode}` consent routes, throttled per client IP on
/// the short `user_code` they look up. The limiter is passed in (rather than
/// pulled from `AppState`) so the layer's state is the limiter itself, keeping
/// the throttle scoped to exactly these routes — the brute-forceable surface —
/// instead of the whole `/access` tree.
pub fn router(rate_limiter: SlidingWindowRateLimiter) -> Router<AppState> {
    Router::new()
        .route("/devices/{userCode}", get::route())
        .route("/devices/{userCode}/approve", approve::route())
        .route("/devices/{userCode}/deny", deny::route())
        .layer(from_fn_with_state(rate_limiter, rate_limit_user_code))
}
