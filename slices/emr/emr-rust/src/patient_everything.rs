//! `GET /Patient/{id}/$everything` override mounted ahead of HFS.
//!
//! HFS doesn't implement the FHIR [`$everything`](https://hl7.org/fhir/R4/patient-operation-everything.html)
//! operation. Rather than patch helios upstream, we mount this handler at
//! `/fhir-r4/Patient/{id}/$everything` and put HFS's router behind it as a
//! fallback (see [`lib.rs`](crate)) — the same shape as the
//! [`smart_configuration`](crate) discovery override.
//!
//! Unlike that override, `$everything` needs the store. Instead of reading it
//! directly, this handler **delegates data-fetching to HFS's own handlers
//! in-process**: a `read` for the primary Patient and a type-level search for
//! its `Observation`s. It re-drives a clone of HFS's router with sub-requests
//! that carry the caller's headers (including `Authorization`), so HFS's SMART
//! v2 scope enforcement stays in the path exactly as it would for a direct
//! `GET /Patient/{id}` — a token that can't read Patient/Observation gets the
//! same `401`/`403` here, propagated verbatim.
//!
//! ## Why the related resources are matched in memory
//!
//! FHIR would express "the Patient's Observations" as a compartment search
//! (`GET /Patient/{id}/Observation`, matched on `Observation.subject`). HFS
//! supports that, but only when the `Observation.subject` search parameter is
//! *indexed*, which requires the FHIR SearchParameter spec files loaded from a
//! `data/` dir. This embedding ships none (the backend opens with
//! `data_dir: None`), so only a minimal `_id`/`_lastUpdated` index exists and a
//! `subject=` search returns nothing. We therefore fetch the `Observation`
//! type-level search (which needs no index) and match `subject.reference`
//! against `Patient/{id}` in memory — exactly what the TypeScript `fhir-r4`
//! twin's `$everything` does, and for the same reason.
//!
//! ## Scope
//!
//! Related resources are `Observation`s only — the resources the emr slice
//! actually stores that reference a Patient (`Binary`, the other stored type,
//! doesn't). `_count` truncates the matched `Observation`s (the primary Patient
//! is always included).
//!
//! ## Known limitation: the candidate fetch is a single page
//!
//! The `Observation` candidates come from one type-level search page capped at
//! [`OBSERVATION_FETCH_LIMIT`] resources — it is *not* paged to exhaustion.
//! Because the search is store-wide (not compartment-scoped) and only the first
//! page is inspected, the cap bounds the *total* `Observation`s the store may
//! hold before results become lossy, not the target patient's own count: once
//! the store holds more than [`OBSERVATION_FETCH_LIMIT`] `Observation`s across
//! *all* patients, a target patient whose rows fall outside the first page has
//! them silently omitted — even a patient with only a handful. This diverges
//! from the TypeScript `fhir-r4` twin, which queries the store unbounded and so
//! never drops a matching row. Paging the delegated search to exhaustion (or a
//! real `subject`-indexed compartment search) would close the gap; see the
//! spec-gap catalogue in `fhir-r4/docs/Capability Statement.md`.

use axum::body::{to_bytes, Body};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, Request, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use axum::Router;
use serde::Deserialize;
use serde_json::{json, Value};
use shared_structures_rust::served_origin::served_base_url_for;
use tower::ServiceExt;

use crate::FHIR_R4_PATH;

/// Upper bound on bytes buffered from a delegated sub-response body. The
/// candidate fetch is capped at [`OBSERVATION_FETCH_LIMIT`] resources, so a
/// single body stays well under this; the cap just guards a pathological body.
const MAX_SUBRESPONSE_BYTES: usize = 32 * 1024 * 1024;

/// How many `Observation`s to fetch as `$everything` candidates before matching
/// `subject.reference` in memory. Set to HFS's default `max_page_size` (1000)
/// so the type-level search returns as many as HFS will serve in one page. Only
/// this first page is inspected: once the store holds more than this many
/// `Observation`s across *all* patients, a target patient's rows outside the
/// page are dropped — see the module-level "Known limitation" note.
const OBSERVATION_FETCH_LIMIT: u32 = 1000;

/// State threaded to the `$everything` handler: a clone of HFS's router to
/// re-drive in-process, plus the loopback origin used as the served-origin
/// fallback (same base the discovery override derives its URLs from).
#[derive(Clone)]
pub(crate) struct EverythingState {
    pub hfs_router: Router,
    pub loopback_base_url: url::Url,
}

/// `$everything` URL parameters. Only `_count` is honored today; unknown params
/// are ignored (deserialized away), matching HFS's lenient search handling.
#[derive(Debug, Deserialize)]
pub(crate) struct EverythingParams {
    #[serde(rename = "_count")]
    count: Option<u32>,
}

pub(crate) async fn patient_everything_handler(
    State(state): State<EverythingState>,
    Path(id): Path<String>,
    Query(params): Query<EverythingParams>,
    headers: HeaderMap,
) -> Response {
    // FHIR base URL for `fullUrl`s and the `self` link, per served base URL —
    // the same derivation the discovery override uses. A forwarded host that
    // cleared validation but failed to parse leaves no base URL to build links
    // from, so 500 rather than emit a Bundle with a malformed `self`/`fullUrl`.
    let mut fhir_base = match served_base_url_for(&headers, &state.loopback_base_url) {
        Some(base_url) => base_url,
        None => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    fhir_base.set_path(FHIR_R4_PATH);

    // 1. Read the primary Patient by delegating to HFS. Any non-200 (`404` for a
    //    missing patient, `401`/`403` when scopes are lacking, `503`, …) is
    //    propagated verbatim so the caller sees HFS's own OperationOutcome.
    let patient_resp = delegate_get(&state.hfs_router, &format!("/Patient/{id}"), &headers).await;
    if patient_resp.status() != StatusCode::OK {
        return patient_resp;
    }
    let patient = match read_json(patient_resp).await {
        Ok(value) => value,
        Err(resp) => return resp,
    };

    // 2. Fetch Observation candidates via the type-level search (no index
    //    needed) and match `subject.reference` in memory — see the module docs
    //    for why we don't use a compartment/`subject=` search here.
    let obs_resp = delegate_get(
        &state.hfs_router,
        &format!("/Observation?_count={OBSERVATION_FETCH_LIMIT}"),
        &headers,
    )
    .await;
    if obs_resp.status() != StatusCode::OK {
        return obs_resp;
    }
    let obs_bundle = match read_json(obs_resp).await {
        Ok(value) => value,
        Err(resp) => return resp,
    };

    let subject_ref = format!("Patient/{id}");
    let mut observations: Vec<Value> = obs_bundle
        .get("entry")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| entry.get("resource"))
                .filter(|resource| {
                    resource
                        .get("subject")
                        .and_then(|subject| subject.get("reference"))
                        .and_then(Value::as_str)
                        == Some(subject_ref.as_str())
                })
                .cloned()
                .collect()
        })
        .unwrap_or_default();

    // `_count` caps the *matched* Observations; the primary Patient is always
    // included on top (mirrors the twin's `.slice(0, limit)`).
    if let Some(count) = params.count {
        observations.truncate(count as usize);
    }

    // 3. Merge into one searchset Bundle: Patient first, then its Observations.
    let mut resources: Vec<Value> = vec![patient];
    resources.append(&mut observations);

    let self_url = {
        let mut url = format!("{fhir_base}/Patient/{id}/$everything");
        if let Some(count) = params.count {
            url.push_str(&format!("?_count={count}"));
        }
        url
    };

    (
        StatusCode::OK,
        Json(build_searchset_bundle(
            fhir_base.as_str(),
            &self_url,
            &resources,
        )),
    )
        .into_response()
}

/// Re-drive HFS's router with an in-process `GET` sub-request, forwarding the
/// caller's headers (except `Accept-Encoding`, see below) so tenant/version
/// resolution and auth behave exactly as they would for a direct request.
/// `path_and_query` is relative to the FHIR base
/// (the `/fhir-r4` nest prefix is already stripped by the time HFS sees it),
/// e.g. `/Patient/p1` or `/Patient/p1/Observation?_count=5`.
async fn delegate_get(router: &Router, path_and_query: &str, headers: &HeaderMap) -> Response {
    let mut builder = Request::builder().method("GET").uri(path_and_query);
    for (name, value) in headers {
        // Don't offer content negotiation for compression on the sub-request:
        // HFS's tower-http stack may honor the caller's `Accept-Encoding: gzip`
        // and return a compressed body, but [`read_json`] parses the raw bytes
        // as JSON with no decompression step — a forwarded `Accept-Encoding`
        // would turn every delegated read into a `500` parse failure. Strip it
        // so the sub-response is always identity-encoded.
        if name == axum::http::header::ACCEPT_ENCODING {
            continue;
        }
        builder = builder.header(name, value);
    }
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

/// Buffer and JSON-parse a delegated sub-response body, mapping I/O or parse
/// failures to a `500` OperationOutcome.
async fn read_json(response: Response) -> Result<Value, Response> {
    let bytes = to_bytes(response.into_body(), MAX_SUBRESPONSE_BYTES)
        .await
        .map_err(|err| internal_error(&format!("failed to read sub-response body: {err}")))?;
    serde_json::from_slice(&bytes)
        .map_err(|err| internal_error(&format!("failed to parse sub-response JSON: {err}")))
}

/// Build the `searchset` Bundle. Each entry gets a `fullUrl` (when the resource
/// carries a `resourceType`/`id`) and `search.mode: "match"`; `total` counts the
/// entries (primary + related).
fn build_searchset_bundle(fhir_base: &str, self_url: &str, resources: &[Value]) -> Value {
    let entries: Vec<Value> = resources
        .iter()
        .map(|resource| {
            let mut entry = json!({
                "resource": resource,
                "search": { "mode": "match" },
            });
            if let (Some(resource_type), Some(id)) = (
                resource.get("resourceType").and_then(Value::as_str),
                resource.get("id").and_then(Value::as_str),
            ) {
                entry["fullUrl"] = Value::String(format!("{fhir_base}/{resource_type}/{id}"));
            }
            entry
        })
        .collect();

    json!({
        "resourceType": "Bundle",
        "type": "searchset",
        "total": entries.len(),
        "link": [{ "relation": "self", "url": self_url }],
        "entry": entries,
    })
}

/// A `500` OperationOutcome for the (unexpected) case that a delegated
/// sub-response can't be read or parsed.
fn internal_error(diagnostics: &str) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({
            "resourceType": "OperationOutcome",
            "issue": [{
                "severity": "error",
                "code": "exception",
                "diagnostics": diagnostics,
            }],
        })),
    )
        .into_response()
}
