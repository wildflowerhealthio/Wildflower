//! Axum request extractors for the gatekeeper's HTTP layer. Each extractor
//! reaches into the gatekeeper's [`AppState`](crate::http::state::AppState) or
//! request parts to hand a handler a ready-to-use value, so a handler declares
//! what it needs in its signature instead of threading a `HeaderMap` and
//! calling a resolver by hand.

pub(crate) mod served_origin;
