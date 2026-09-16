use axum::extract::Path;
use axum::http::{header, HeaderMap, HeaderValue};
use axum::response::{IntoResponse, Response};

use scope_capabilities_rust::{InsufficientScopeBody, Scoped};

use crate::domain::DicomFileError;
use crate::http::errors::DicomFileNotFoundBody;
use crate::live_bindings::LiveDicomFileReader;

#[utoipa::path(
    get,
    tag = "DICOM Files",
    path = "/api/dicom/files/{id}",
    params(("id" = String, Path, description = "DocumentReference id")),
    responses(
        (status = 200, description = "Raw DICOM file bytes", content_type = "application/octet-stream"),
        (status = 403, description = "The caller's token doesn't cover `user/DocumentReference.r`", body = InsufficientScopeBody),
        (status = 404, description = "No DocumentReference with this id or no attachment data", body = DicomFileNotFoundBody),
    ),
)]
pub(crate) async fn handle_get_dicom_file(
    reader: Scoped<LiveDicomFileReader>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, DicomFileError> {
    let file = reader.get_file(&id, &headers).await?;

    let content_type = HeaderValue::from_str(&file.content_type)
        .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream"));

    let mut response = file.bytes.into_response();
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, content_type);
    Ok(response)
}
