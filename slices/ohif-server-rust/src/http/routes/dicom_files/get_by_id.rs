use axum::extract::Path;
use axum::http::{header, HeaderMap, HeaderValue};
use axum::response::{IntoResponse, Response};

use scope_capabilities_rust::Scoped;

use crate::domain::DicomFileError;
use crate::http::errors::{DicomFileForbiddenBody, DicomFileNotFoundBody};
use crate::live_bindings::LiveDicomFileReader;

#[utoipa::path(
    get,
    tag = "DICOM Files",
    path = "/api/dicom/files/{id}",
    params(("id" = String, Path, description = "DocumentReference id")),
    responses(
        (status = 200, description = "Raw DICOM file bytes", content_type = "application/octet-stream"),
        (status = 403, description = "Missing/invalid bearer token or insufficient scopes", body = DicomFileForbiddenBody),
        (status = 404, description = "No DocumentReference with this id or no attachment data", body = DicomFileNotFoundBody),
    ),
)]
pub(crate) async fn handle_get_dicom_file(
    reader: Scoped<LiveDicomFileReader>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, DicomFileError> {
    let auth_token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or_else(|| DicomFileError::Forbidden {
            id: id.clone(),
            detail: "missing or malformed Authorization header".to_owned(),
        })?;

    let file = reader.get_file(&id, auth_token).await?;

    let content_type = HeaderValue::from_str(&file.content_type)
        .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream"));

    let mut response = file.bytes.into_response();
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, content_type);
    Ok(response)
}
