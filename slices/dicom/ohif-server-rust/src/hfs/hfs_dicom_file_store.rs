use axum::body::{to_bytes, Body};
use axum::http::{HeaderMap, Request, StatusCode};
use axum::Router;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::Value;
use tower::ServiceExt;

use crate::domain::{DicomFile, DicomFileError, DicomFileStore};

const MAX_FHIR_BODY_BYTES: usize = 1024 * 1024 * 1024; // 1 GiB

/// [`DicomFileStore`] adapter that reads DICOM file bytes by delegating a
/// `GET /DocumentReference/{id}` to HFS in-process. Forwards the caller's
/// headers (minus content-negotiation) so HFS's bearer-JWT + SMART v2 scope
/// enforcement stays in the path.
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
    async fn get_file(
        &self,
        id: &str,
        caller_headers: &HeaderMap,
    ) -> Result<DicomFile, DicomFileError> {
        let response = delegate_get(
            &self.hfs_router,
            &format!("/DocumentReference/{id}"),
            caller_headers,
        )
        .await;

        if response.status() != StatusCode::OK {
            return Err(DicomFileError::NotFound {
                id: id.to_owned(),
                detail: format!(
                    "HFS returned {} for DocumentReference/{id}",
                    response.status()
                ),
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

        let bytes = STANDARD.decode(data).map_err(|err| {
            DicomFileError::Infrastructure {
                context: "base64 decode",
                source: format!(
                    "DocumentReference/{id}'s attachment data is not valid base64: {err}"
                ),
            }
        })?;

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

/// Re-drive HFS's router with an in-process `GET`, forwarding the caller's
/// headers (minus content-negotiation) so auth behaves as for a direct request.
async fn delegate_get(
    router: &Router,
    path_and_query: &str,
    headers: &HeaderMap,
) -> axum::response::Response {
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

async fn read_json(
    response: axum::response::Response,
) -> Result<Value, DicomFileError> {
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
