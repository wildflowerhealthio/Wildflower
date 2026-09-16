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
//! **In-process re-drive invariant:** see [`crate::delegate`] — this handler's
//! delegated reads (the primary Patient, each related-type search) go through
//! [`crate::delegate::delegate_get`] and [`crate::delegate::read_json`], shared
//! with [`crate::dicom_files`]'s single-resource read.
//!
//! A related-resource search that fails (non-200 or an unreadable body) is
//! logged and treated as *no matches* rather than aborting: only the primary
//! Patient read is fatal. This keeps `$everything` useful for a partial-scope
//! token — one that can read Patient and Observation but not MedicationRequest
//! still gets a Bundle with the Patient and its Observations.
//!
//! ## How the related resources are matched (server-side, indexed)
//!
//! FHIR expresses "the Patient's Observations" as a search on the resource's
//! patient reference (`GET /Observation?subject=Patient/{id}`, the same match a
//! `Patient/{id}/Observation` compartment search performs). HFS resolves that
//! **server-side** against its search index because `emr-rust` loads the full
//! FHIR R4 `SearchParameter` set at startup (see `crate::setup_fhir_r4` and this
//! crate's `docs/Capability Statement.md`), so `Observation.subject` /
//! `MedicationRequest.subject` are indexed at write time. We delegate one such
//! search per related type and let HFS do the filtering — no in-memory
//! `subject.reference` match, and no store-wide candidate scan.
//!
//! Each delegated search is **paged to exhaustion**: HFS returns a page plus a
//! `next` cursor link, and [`search_referencing_patient`] follows the cursor
//! until no `next` remains, so every matching resource is returned regardless of
//! how many the patient (or the store) holds.
//!
//! ## Scope
//!
//! Related resources are the patient-referencing types in
//! [`RELATED_RESOURCE_TYPES`] — `Observation`, `MedicationRequest`, and
//! `DiagnosticReport` today.
//! FHIR `$everything` returns the whole patient compartment; we include only the
//! types in that table, searched on their `subject` reference. HFS is a general
//! FHIR store, so the table can grow to any patient-referencing type it serves.
//! `_count` truncates the combined matched set (the primary Patient is always
//! included on top). Adding a type is a one-row change to the table — record the
//! divergence in this crate's `docs/Capability Statement.md` in the same change.

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use axum::Router;
use serde::Deserialize;
use serde_json::{json, Value};
use shared_structures_rust::served_origin::served_base_url_for;

use crate::delegate::{delegate_get, internal_error, read_json};
use crate::FHIR_R4_PATH;

/// Upper bound on bytes buffered from a single delegated search *page* body.
/// Pages are bounded by HFS's `max_page_size`, so one body stays well under
/// this; the cap just guards a pathological body.
const MAX_SUBRESPONSE_BYTES: usize = 32 * 1024 * 1024;

/// A FHIR resource type gathered into a Patient `$everything` Bundle alongside
/// the Patient, and the search parameter whose value is the `Patient/{id}`
/// reference. Each is gathered with an indexed, server-side, fully-paged search
/// (`GET /{resource_type}?{patient_search_param}=Patient/{id}`).
struct RelatedType {
    /// FHIR resource type name, e.g. `"Observation"` — the type-level search path
    /// (`/{resource_type}`) and the `resourceType` these rows carry.
    resource_type: &'static str,
    /// Search parameter carrying the `Patient/{id}` reference. FHIR names this
    /// per-resource; every type we gather today uses `subject`
    /// (`Observation.subject`, `MedicationRequest.subject`,
    /// `DiagnosticReport.subject`). We use `subject`
    /// rather than the `patient` param because `subject` indexes a plain
    /// reference, whereas `patient`'s `.where(resolve() is Patient)` expression
    /// depends on `resolve()` at index time.
    patient_search_param: &'static str,
}

/// The related resource types a Patient `$everything` gathers, in Bundle order
/// after the Patient. To include another patient-referencing type HFS stores,
/// add a row here — the handler loops over this table with no other change.
///
/// HFS is a general FHIR store, so `$everything` gathers every patient-referencing
/// type in this table — `Observation`, `MedicationRequest` and
/// `DiagnosticReport` today. See the
/// "Scope" module note and the server capability statement in this crate's
/// `docs/Capability Statement.md`.
const RELATED_RESOURCE_TYPES: &[RelatedType] = &[
    RelatedType {
        resource_type: "Observation",
        patient_search_param: "subject",
    },
    RelatedType {
        resource_type: "MedicationRequest",
        patient_search_param: "subject",
    },
    RelatedType {
        resource_type: "DiagnosticReport",
        patient_search_param: "subject",
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
    let patient = match read_json(patient_resp, MAX_SUBRESPONSE_BYTES).await {
        Ok(value) => value,
        Err(resp) => return resp,
    };

    // 2. Gather related resources. For each type in `RELATED_RESOURCE_TYPES`,
    //    run an indexed, server-side search on its patient reference
    //    (`?subject=Patient/{id}`) and page it to exhaustion — HFS does the
    //    filtering, so no in-memory `subject.reference` match and no store-wide
    //    candidate cap.
    //
    //    Unlike the primary Patient read, a related search that fails (a non-200
    //    or an unreadable body) is logged and treated as *no matches* rather than
    //    aborting the operation: a partial-scope token that can read Patient but
    //    not, say, MedicationRequest still gets a Bundle with everything it is
    //    allowed to see.
    let subject_ref = format!("Patient/{id}");
    let mut related: Vec<Value> = Vec::new();
    for related_type in RELATED_RESOURCE_TYPES {
        let matches = search_referencing_patient(
            &state.hfs_router,
            related_type.resource_type,
            related_type.patient_search_param,
            &subject_ref,
            &headers,
        )
        .await;
        related.extend(matches);
    }

    // `_count` caps the *matched* related resources; the primary Patient is
    // always included on top.
    if let Some(count) = params.count {
        related.truncate(count as usize);
    }

    // 3. Merge into one searchset Bundle: Patient first, then its related
    //    resources.
    let mut resources: Vec<&Value> = vec![&patient];
    resources.extend(related.iter());

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

/// Gather every resource of `resource_type` whose `search_param` references
/// `subject_ref` (`Patient/{id}`), by delegating an indexed server-side search
/// to HFS and following its `next` cursor link to exhaustion.
///
/// A search page that fails (non-200 — e.g. a partial-scope `403` — or an
/// unreadable body) is logged and stops the walk for this type, yielding
/// whatever pages were gathered so far (none, if the very first page failed).
/// This preserves `$everything`'s graceful degradation: a token lacking scope
/// for one related type still gets the rest.
async fn search_referencing_patient(
    router: &Router,
    resource_type: &str,
    search_param: &str,
    subject_ref: &str,
    headers: &HeaderMap,
) -> Vec<Value> {
    let mut matches: Vec<Value> = Vec::new();
    // Cursor of the *next* page to fetch; `None` for the first page.
    let mut cursor: Option<String> = None;
    loop {
        // Build the search path in a scope so the `Serializer` (which is not
        // `Send`) is dropped before the `.await` below — otherwise the handler
        // future is `!Send` and won't satisfy axum's `Handler` bound.
        let path = {
            let mut query = url::form_urlencoded::Serializer::new(String::new());
            query.append_pair(search_param, subject_ref);
            if let Some(cursor) = &cursor {
                query.append_pair("_cursor", cursor);
            }
            format!("/{resource_type}?{}", query.finish())
        };

        let resp = delegate_get(router, &path, headers).await;
        if resp.status() != StatusCode::OK {
            tracing::warn!(
                resource_type,
                status = %resp.status(),
                "patient $everything: related search returned non-200; omitting remaining pages",
            );
            break;
        }
        let bundle = match read_json(resp, MAX_SUBRESPONSE_BYTES).await {
            Ok(bundle) => bundle,
            Err(_) => {
                tracing::warn!(
                    resource_type,
                    "patient $everything: related search body unreadable; omitting remaining pages",
                );
                break;
            }
        };

        if let Some(entries) = bundle.get("entry").and_then(Value::as_array) {
            for entry in entries {
                if let Some(resource) = entry.get("resource") {
                    matches.push(resource.clone());
                }
            }
        }

        match next_page_cursor(&bundle) {
            // Guard against a pathological `next` that doesn't advance: if the
            // server hands back the cursor we just used, stop rather than loop
            // forever (normal keyset cursors always move forward).
            Some(next) if Some(&next) != cursor.as_ref() => cursor = Some(next),
            _ => break,
        }
    }
    matches
}

/// Extract the `_cursor` of a search Bundle's `next` link, if any — the token to
/// pass as `_cursor` on the follow-up request. Returns `None` when there is no
/// `next` link (last page) or it carries no `_cursor` (nothing more to page).
fn next_page_cursor(bundle: &Value) -> Option<String> {
    let next_url = bundle
        .get("link")
        .and_then(Value::as_array)?
        .iter()
        .find(|link| link.get("relation").and_then(Value::as_str) == Some("next"))
        .and_then(|link| link.get("url"))
        .and_then(Value::as_str)?;
    // HFS builds the `next` link as an absolute URL off its configured base; we
    // only need the opaque `_cursor` token from its query (already percent-decoded
    // by the parser), re-issued against our own known search path.
    url::Url::parse(next_url)
        .ok()?
        .query_pairs()
        .find(|(key, _)| key == "_cursor")
        .map(|(_, value)| value.into_owned())
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
