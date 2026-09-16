use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use axum::Router;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use bytes::Bytes;
use serde_json::Value;
use tower::ServiceExt;

use crate::domain::{DicomFile, DicomFileError, DicomFileStore};

const MAX_FHIR_BODY_BYTES: usize = 1024 * 1024 * 1024; // 1 GiB

/// [`DicomFileStore`] adapter that reads DICOM file bytes by delegating a
/// `GET /DocumentReference/{id}` to HFS in-process. Constructs an
/// `Authorization: Bearer <token>` header from the caller's auth token so
/// HFS's bearer-JWT + SMART v2 scope enforcement stays in the path.
#[derive(Clone)]
pub(crate) struct HfsDicomFileStore {
    hfs_router: Router,
}

impl HfsDicomFileStore {
    pub(crate) fn new(hfs_router: Router) -> Self {
        Self { hfs_router }
    }
}

impl DicomFileStore for HfsDicomFileStore {
    async fn get_file(&self, id: &str, auth_token: &str) -> Result<DicomFile, DicomFileError> {
        let response = delegate_get(
            &self.hfs_router,
            &format!("/DocumentReference/{id}"),
            auth_token,
        )
        .await;

        let status = response.status();
        if status == StatusCode::NOT_FOUND {
            return Err(DicomFileError::NotFound {
                id: id.to_owned(),
                detail: format!("HFS returned 404 for DocumentReference/{id}"),
            });
        }
        if status == StatusCode::FORBIDDEN || status == StatusCode::UNAUTHORIZED {
            let body = read_body_lossy(response).await;
            return Err(DicomFileError::Forbidden {
                id: id.to_owned(),
                detail: format!("HFS returned {status} for DocumentReference/{id}: {body}"),
            });
        }
        if !status.is_success() {
            let body = read_body_lossy(response).await;
            return Err(DicomFileError::Infrastructure {
                context: "HFS sub-request",
                source: format!("HFS returned {status} for DocumentReference/{id}: {body}"),
            });
        }

        let document = read_json(response).await?;

        let attachment = document
            .get("content")
            .and_then(Value::as_array)
            .and_then(|content| content.first())
            .and_then(|entry| entry.get("attachment"))
            .ok_or_else(|| DicomFileError::NotFound {
                id: id.to_owned(),
                detail: format!("DocumentReference/{id} has no content attachment"),
            })?;

        let data = attachment
            .get("data")
            .and_then(Value::as_str)
            .ok_or_else(|| DicomFileError::NotFound {
                id: id.to_owned(),
                detail: format!("DocumentReference/{id}'s attachment carries no inline data"),
            })?;

        let bytes: Bytes = STANDARD
            .decode(data)
            .map_err(|err| DicomFileError::Infrastructure {
                context: "base64 decode",
                source: format!(
                    "DocumentReference/{id}'s attachment data is not valid base64: {err}"
                ),
            })?
            .into();

        let content_type = attachment
            .get("contentType")
            .and_then(Value::as_str)
            .unwrap_or("application/octet-stream")
            .to_owned();

        Ok(DicomFile {
            bytes,
            content_type,
        })
    }
}

/// Re-drive HFS's router with an in-process `GET`, setting an Authorization
/// bearer header from the caller's token so auth behaves as for a direct
/// request.
async fn delegate_get(
    router: &Router,
    path_and_query: &str,
    auth_token: &str,
) -> axum::response::Response {
    let bearer = format!("Bearer {auth_token}");
    let request = match Request::builder()
        .method("GET")
        .uri(path_and_query)
        .header(axum::http::header::AUTHORIZATION, &bearer)
        .header(axum::http::header::ACCEPT, "application/fhir+json")
        .body(Body::empty())
    {
        Ok(request) => request,
        Err(err) => {
            return axum::response::IntoResponse::into_response((
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to build sub-request: {err}"),
            ));
        }
    };
    match router.clone().oneshot(request).await {
        Ok(response) => response,
        Err(infallible) => match infallible {},
    }
}

async fn read_body_lossy(response: axum::response::Response) -> String {
    match to_bytes(response.into_body(), MAX_FHIR_BODY_BYTES).await {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(_) => "<unreadable body>".to_owned(),
    }
}

async fn read_json(response: axum::response::Response) -> Result<Value, DicomFileError> {
    let bytes = to_bytes(response.into_body(), MAX_FHIR_BODY_BYTES)
        .await
        .map_err(|err| DicomFileError::Infrastructure {
            context: "read sub-response body",
            source: err.to_string(),
        })?;
    serde_json::from_slice(&bytes).map_err(|err| DicomFileError::Infrastructure {
        context: "parse sub-response JSON",
        source: err.to_string(),
    })
}
