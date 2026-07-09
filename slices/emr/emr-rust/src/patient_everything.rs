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
//! in-process**: a `read` for the primary Patient, then a type-level search per
//! [`RelatedType`] in [`RELATED_RESOURCE_TYPES`]. It re-drives a clone of HFS's
//! router with sub-requests that carry the caller's headers (including
//! `Authorization`), so HFS's SMART v2 scope enforcement stays in the path
//! exactly as it would for a direct `GET /Patient/{id}` — a token that can't read
//! the Patient gets the same `401`/`403` here, propagated verbatim.
//!
//! A related-resource search that fails (non-200 or an unreadable body) is
//! logged and treated as *no matches* rather than aborting: only the primary
//! Patient read is fatal. This keeps `$everything` useful for a partial-scope
//! token — one that can read Patient and Observation but not MedicationRequest
//! still gets a Bundle with the Patient and its Observations.
//!
//! ## Why the related resources are matched in memory
//!
//! FHIR would express "the Patient's Observations" as a compartment search
//! (`GET /Patient/{id}/Observation`, matched on `Observation.subject`). HFS
//! supports that, but only when the `Observation.subject` search parameter is
//! *indexed*, which requires the FHIR SearchParameter spec files loaded from a
//! `data/` dir. This embedding ships none (the backend opens with
//! `data_dir: None`), so only a minimal `_id`/`_lastUpdated` index exists and a
//! `subject=` search returns nothing. We therefore fetch each related type's
//! type-level search (which needs no index) and match its patient reference
//! against `Patient/{id}` in memory.
//!
//! ## Scope
//!
//! Related resources are the patient-referencing types in
//! [`RELATED_RESOURCE_TYPES`] — `Observation` and `MedicationRequest` today.
//! FHIR `$everything` returns the whole patient compartment; we include only the
//! types in that table, matched on their `subject` reference. HFS is a general
//! FHIR store, so the table can grow to any patient-referencing type it serves.
//! `_count` truncates the combined matched set (the primary Patient is always
//! included on top). Adding a type is a one-row change to the table — record the
//! divergence in this crate's `docs/Capability Statement.md` in the same change.
//!
//! ## Known limitation: each candidate fetch is a single page
//!
//! Each related type's candidates come from one type-level search page capped at
//! [`RELATED_FETCH_LIMIT`] resources — it is *not* paged to exhaustion. Because
//! the search is store-wide (not compartment-scoped) and only the first page is
//! inspected, the cap bounds the *total* resources of that type the store may
//! hold before results become lossy, not the target patient's own count: once
//! the store holds more than [`RELATED_FETCH_LIMIT`] of a type across *all*
//! patients, a target patient whose rows fall outside the first page has them
//! silently omitted — even a patient with only a handful. Paging the delegated
//! search to exhaustion (or a real indexed compartment search) would close the
//! gap; see the server capability statement in this crate's
//! `docs/Capability Statement.md`.

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

/// Upper bound on bytes buffered from a delegated sub-response body. Each
/// candidate fetch is capped at [`RELATED_FETCH_LIMIT`] resources, so a single
/// body stays well under this; the cap just guards a pathological body.
const MAX_SUBRESPONSE_BYTES: usize = 32 * 1024 * 1024;

/// How many resources of a related type to fetch as `$everything` candidates
/// before matching the patient reference in memory. Set to HFS's default
/// `max_page_size` (1000) so each type-level search returns as many as HFS will
/// serve in one page. Only this first page is inspected: once the store holds
/// more than this many of a type across *all* patients, a target patient's rows
/// outside the page are dropped — see the module-level "Known limitation" note.
const RELATED_FETCH_LIMIT: u32 = 1000;

/// A FHIR resource type gathered into a Patient `$everything` Bundle alongside
/// the Patient, and the element on each row that carries the `Patient/{id}`
/// reference we match on. Each is fetched via an unindexed type-level search and
/// matched to the target patient in memory (see the module docs for why).
struct RelatedType {
    /// FHIR resource type name, e.g. `"Observation"` — the type-level search path
    /// (`/{resource_type}`) and the `resourceType` these rows carry.
    resource_type: &'static str,
    /// Element holding the `Patient/{id}` reference to match on. FHIR names this
    /// per-resource; both types we gather today use `subject`
    /// (`Observation.subject`, `MedicationRequest.subject`).
    patient_reference_field: &'static str,
}

/// The related resource types a Patient `$everything` gathers, in Bundle order
/// after the Patient. To include another patient-referencing type HFS stores,
/// add a row here — the handler loops over this table with no other change.
///
/// HFS is a general FHIR store, so `$everything` gathers every patient-referencing
/// type in this table — `Observation` and `MedicationRequest` today. See the
/// "Scope" module note and the server capability statement in this crate's
/// `docs/Capability Statement.md`.
const RELATED_RESOURCE_TYPES: &[RelatedType] = &[
    RelatedType {
        resource_type: "Observation",
        patient_reference_field: "subject",
    },
    RelatedType {
        resource_type: "MedicationRequest",
        patient_reference_field: "subject",
    },
];

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
        None => return internal_error("forwarded header did not indicate a valid served base URL"),
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

    // 2. Gather related resources. For each type in `RELATED_RESOURCE_TYPES`,
    //    fetch a type-level search page (no index needed) and keep the parsed
    //    Bundle alive so matched resources can be borrowed straight out of it at
    //    serialize time — no clone. See the module docs for why we match in
    //    memory rather than with a compartment/`subject=` search.
    //
    //    Unlike the primary Patient read, a related search that fails (a non-200
    //    or an unreadable body) is logged and treated as *no matches* rather than
    //    aborting the operation: a partial-scope token that can read Patient but
    //    not, say, MedicationRequest still gets a Bundle with everything it is
    //    allowed to see.
    let mut related_bundles: Vec<(&'static str, Value)> =
        Vec::with_capacity(RELATED_RESOURCE_TYPES.len());
    for related in RELATED_RESOURCE_TYPES {
        let resp = delegate_get(
            &state.hfs_router,
            &format!("/{}?_count={RELATED_FETCH_LIMIT}", related.resource_type),
            &headers,
        )
        .await;
        if resp.status() != StatusCode::OK {
            tracing::warn!(
                resource_type = related.resource_type,
                status = %resp.status(),
                "patient $everything: related search returned non-200; omitting this type",
            );
            continue;
        }
        match read_json(resp).await {
            Ok(bundle) => related_bundles.push((related.patient_reference_field, bundle)),
            Err(_) => tracing::warn!(
                resource_type = related.resource_type,
                "patient $everything: related search body unreadable; omitting this type",
            ),
        }
    }

    let subject_ref = format!("Patient/{id}");
    let subject_ref = subject_ref.as_str();
    let mut related: Vec<&Value> = related_bundles
        .iter()
        .flat_map(|(reference_field, bundle)| {
            let reference_field = *reference_field;
            bundle
                .get("entry")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|entry| entry.get("resource"))
                .filter(move |resource| {
                    resource
                        .get(reference_field)
                        .and_then(|reference| reference.get("reference"))
                        .and_then(Value::as_str)
                        == Some(subject_ref)
                })
        })
        .collect();

    // `_count` caps the *matched* related resources; the primary Patient is
    // always included on top.
    if let Some(count) = params.count {
        related.truncate(count as usize);
    }

    // 3. Merge into one searchset Bundle: Patient first, then its related
    //    resources.
    let mut resources: Vec<&Value> = vec![&patient];
    resources.extend(related);

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
/// caller's headers (except the content-negotiation pair, see below) so
/// tenant/version resolution and auth behave exactly as they would for a direct
/// request. `path_and_query` is relative to the FHIR base
/// (the `/fhir-r4` nest prefix is already stripped by the time HFS sees it),
/// e.g. `/Patient/p1` or `/Patient/p1/Observation?_count=5`.
async fn delegate_get(router: &Router, path_and_query: &str, headers: &HeaderMap) -> Response {
    let mut builder = Request::builder().method("GET").uri(path_and_query);
    for (name, value) in headers {
        // Drop the caller's content-negotiation headers on the sub-request: we
        // consume the body in-process and [`read_json`] parses the raw bytes as
        // JSON with no decode/negotiation step, so a forwarded `Accept-Encoding:
        // gzip` (HFS's tower-http stack gzips the body) or `Accept:
        // application/fhir+xml` (HFS emits XML) would turn every delegated read
        // into a `500` parse failure. Strip both and pin `Accept` to FHIR JSON
        // below so the sub-response is always identity-encoded JSON. The real
        // client's own `Accept`/`Accept-Encoding` are honored by the outer HTTP
        // stack against our own response.
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
fn build_searchset_bundle(fhir_base: &str, self_url: &str, resources: &[&Value]) -> Value {
    let entries: Vec<Value> = resources
        .iter()
        .map(|&resource| {
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
