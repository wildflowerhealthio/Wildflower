//! In-process re-drive of HFS's router, used by [`crate::patient_everything`]
//! to delegate a `GET` back into HFS's own handlers instead of reading the
//! store directly, so HFS's SMART v2 scope enforcement stays in the path
//! exactly as it would for a direct request.
//!
//! See [`delegate_get`] for the in-process re-drive invariant (why
//! `Accept`/`Accept-Encoding` must be stripped) and [`read_json`] for the
//! buffered JSON parse.

use axum::body::{to_bytes, Body};
use axum::http::{HeaderMap, Request, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use axum::Router;
use serde_json::{json, Value};
use tower::ServiceExt;

/// Re-drive HFS's router with an in-process `GET` sub-request, forwarding the
/// caller's headers (except the content-negotiation pair, see below) so
/// tenant/version resolution and auth behave exactly as they would for a direct
/// request. `path_and_query` is relative to the FHIR base
/// (the `/fhir-r4` nest prefix is already stripped by the time HFS sees it),
/// e.g. `/Patient/p1` or `/Patient/p1/Observation?_count=5`.
///
/// **In-process re-drive invariant:** HFS's router is wrapped by
/// `helios-rest`'s `create_app_with_auth` in a `CompressionLayer` and content
/// negotiation, but a delegated sub-response is consumed in-process (buffered
/// and JSON-parsed, [`read_json`]), never sent over the wire. So the forwarded
/// sub-request must drop the caller's content-negotiation headers — an
/// `Accept-Encoding: gzip` would come back gzipped and a forwarded `Accept:
/// application/fhir+xml` would come back XML, either of which fails the parse.
/// This strips both and pins `Accept` to FHIR JSON so the body is always
/// identity-encoded JSON. The real client's own headers are honored by the
/// outer HTTP stack against our response.
pub(crate) async fn delegate_get(
    router: &Router,
    path_and_query: &str,
    headers: &HeaderMap,
) -> Response {
    let mut builder = Request::builder().method("GET").uri(path_and_query);
    for (name, value) in headers {
        if name == axum::http::header::ACCEPT_ENCODING || name == axum::http::header::ACCEPT {
            continue;
        }
        builder = builder.header(name, value);
    }
    builder = builder.header(axum::http::header::ACCEPT, "application/fhir+json");
    let request = match builder.body(Body::empty()) {
        Ok(request) => request,
        Err(err) => return internal_error(&format!("failed to build sub-request: {err}")),
    };
    // `Router`'s `Service` error is `Infallible`, so this never yields `Err`.
    match router.clone().oneshot(request).await {
        Ok(response) => response,
        Err(infallible) => match infallible {},
    }
}

/// Buffer and JSON-parse a delegated sub-response body (up to `max_bytes`),
/// mapping I/O or parse failures to a `500` OperationOutcome.
pub(crate) async fn read_json(response: Response, max_bytes: usize) -> Result<Value, Response> {
    let bytes = to_bytes(response.into_body(), max_bytes)
        .await
        .map_err(|err| internal_error(&format!("failed to read sub-response body: {err}")))?;
    serde_json::from_slice(&bytes)
        .map_err(|err| internal_error(&format!("failed to parse sub-response JSON: {err}")))
}

/// A `500` OperationOutcome for the (unexpected) case that a delegated
/// sub-response can't be read or parsed.
pub(crate) fn internal_error(diagnostics: &str) -> Response {
    operation_outcome(StatusCode::INTERNAL_SERVER_ERROR, "exception", diagnostics)
}

fn operation_outcome(status: StatusCode, code: &str, diagnostics: &str) -> Response {
    (
        status,
        Json(json!({
            "resourceType": "OperationOutcome",
            "issue": [{
                "severity": "error",
                "code": code,
                "diagnostics": diagnostics,
            }],
        })),
    )
        .into_response()
}
