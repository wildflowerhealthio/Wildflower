use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;
use shared_structures_rust::http_errors::InternalError;
use utoipa::ToSchema;

use crate::domain::DicomFileError;

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct DicomFileNotFoundBody {
    pub(crate) error: &'static str,
    pub(crate) id: String,
    pub(crate) detail: String,
}

impl IntoResponse for DicomFileError {
    fn into_response(self) -> Response {
        match self {
            DicomFileError::NotFound { id, detail } => (
                StatusCode::NOT_FOUND,
                Json(DicomFileNotFoundBody {
                    error: "DicomFileNotFound",
                    id,
                    detail,
                }),
            )
                .into_response(),
            DicomFileError::Infrastructure { context, source } => {
                InternalError::new(context, source).into_response()
            }
        }
    }
}
