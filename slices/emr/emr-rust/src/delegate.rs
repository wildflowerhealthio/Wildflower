//! In-process re-drive of HFS's router — delegates through HFS's own handlers
//! so SMART v2 scope enforcement stays in the path. `Accept`/`Accept-Encoding`
//! are stripped so sub-responses are always identity-encoded FHIR JSON.

use axum::body::{to_bytes, Body};
use axum::http::{HeaderMap, Request, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use axum::Router;
use serde_json::{json, Value};
use tower::ServiceExt;

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
