//! `GET /api/dicom/files/{id}`, mounted at the app root rather than under
//! `/fhir-r4` (see [`dicom_files_router`]).
//!
//! `dicom-importer-core` stores an imported `.dcm` file's raw bytes as the
//! sole attachment of a FHIR `DocumentReference` (see that package's
//! `source-file` codec) and stamps the file's id onto the synthesized
//! `ImagingStudy` instance as a `gridfsFileId` extension. Nothing serves those
//! bytes back out as a plain file today — a DICOM viewer (OHIF) needs to
//! fetch them by id over HTTP, not as base64 wrapped in FHIR JSON.
//!
//! This handler bridges the two: it delegates a `GET
//! /DocumentReference/{id}` to HFS in-process (the same pattern as
//! [`crate::patient_everything`] — see [`crate::delegate`] for the
//! in-process re-drive invariant, which keeps HFS's SMART v2 scope
//! enforcement in the path), decodes the first content entry's
//! `attachment.data` from base64, and returns it as the response body with
//! `Content-Type` set from `attachment.contentType` (falling back to
//! `application/octet-stream` if absent or not a valid header value).

use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::Value;

use crate::delegate::{delegate_get, internal_error, not_found, read_json};
use crate::MAX_FHIR_BODY_BYTES;

/// State threaded to the DICOM file handler: a clone of HFS's router to
/// re-drive in-process, the same shape as [`crate::patient_everything::EverythingState`].
#[derive(Clone)]
pub(crate) struct DicomFilesState {
    pub hfs_router: Router,
}

/// Build the standalone `GET /api/dicom/files/{id}` router. Mounted at the
/// app root (not nested under `/fhir-r4`) so an OHIF viewer running as its
/// own origin can fetch DICOM bytes without also carrying the host's
/// Owner-scoped bearer gate — auth still happens, just further down: the
/// handler's [`delegate_get`] re-drive into `hfs_router` runs through HFS's
/// own bearer-JWT + SMART v2 scope enforcement for the underlying
/// `DocumentReference` read (see [`crate::delegate`]), so a request without a
/// token carrying `DocumentReference` read access is rejected there.
pub fn dicom_files_router(hfs_router: Router) -> Router {
    Router::new()
        .route("/api/dicom/files/{id}", get(dicom_file_handler))
        .with_state(DicomFilesState { hfs_router })
}

pub(crate) async fn dicom_file_handler(
    State(state): State<DicomFilesState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let doc_resp = delegate_get(
        &state.hfs_router,
        &format!("/DocumentReference/{id}"),
        &headers,
    )
    .await;
    if doc_resp.status() != StatusCode::OK {
        return doc_resp;
    }
    // The whole decoded resource is buffered in-process (never sent over the
    // wire as-is), so it can carry the full FHIR body limit rather than the
    // smaller per-search-page cap `patient_everything` uses.
    let document = match read_json(doc_resp, MAX_FHIR_BODY_BYTES).await {
        Ok(value) => value,
        Err(resp) => return resp,
    };

    let attachment = match document
        .get("content")
        .and_then(Value::as_array)
        .and_then(|content| content.first())
        .and_then(|entry| entry.get("attachment"))
    {
        Some(attachment) => attachment,
        None => return not_found(&format!("DocumentReference/{id} has no content attachment")),
    };

    let data = match attachment.get("data").and_then(Value::as_str) {
        Some(data) => data,
        None => {
            return not_found(&format!(
                "DocumentReference/{id}'s attachment carries no inline data"
            ))
        }
    };

    let bytes = match STANDARD.decode(data) {
        Ok(bytes) => bytes,
        Err(err) => {
            return internal_error(&format!(
                "DocumentReference/{id}'s attachment data is not valid base64: {err}"
            ))
        }
    };

    let content_type = attachment
        .get("contentType")
        .and_then(Value::as_str)
        .and_then(|value| HeaderValue::from_str(value).ok())
        .unwrap_or_else(|| HeaderValue::from_static("application/octet-stream"));

    let mut response = bytes.into_response();
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, content_type);
    response
}
