mod dicom_files;

use std::sync::Arc;

use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

use crate::live_bindings::state::OhifServerState;

pub(crate) fn openapi_router() -> OpenApiRouter<Arc<OhifServerState>> {
    OpenApiRouter::new().routes(routes!(dicom_files::get_by_id::handle_get_dicom_file))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use axum::Router;
    use http_body_util::BodyExt;
    use scope_capabilities_rust::ScopeClaims;
    use tower::ServiceExt;

    use crate::hfs::HfsDicomFileStore;
    use crate::live_bindings::state::OhifServerState;

    fn state() -> Arc<OhifServerState> {
        Arc::new(OhifServerState::new(HfsDicomFileStore::new(
            mock_hfs_router(),
        )))
    }

    fn router() -> Router<Arc<OhifServerState>> {
        super::openapi_router().split_for_parts().0
    }

    fn mock_hfs_router() -> Router {
        use axum::extract::Path;
        use axum::routing::get;
        use axum::Json;
        use base64::engine::general_purpose::STANDARD;
        use base64::Engine;

        async fn mock_document_reference(Path(id): Path<String>) -> axum::response::Response {
            if id == "doc-1" {
                let data = STANDARD.encode(b"\xDE\xAD\xBE\xEF");
                let body = serde_json::json!({
                    "resourceType": "DocumentReference",
                    "id": "doc-1",
                    "content": [{
                        "attachment": {
                            "contentType": "application/dicom",
                            "data": data,
                        }
                    }]
                });
                Json(body).into_response()
            } else {
                (StatusCode::NOT_FOUND, "not found").into_response()
            }
        }

        use axum::response::IntoResponse;
        Router::new().route("/DocumentReference/{id}", get(mock_document_reference))
    }

    async fn send_scoped(
        state: &Arc<OhifServerState>,
        mut req: Request<Body>,
        scopes: &str,
    ) -> (StatusCode, Vec<u8>) {
        req.extensions_mut()
            .insert(ScopeClaims::new(Some(scopes.to_owned())));
        let res = router()
            .with_state(Arc::clone(state))
            .oneshot(req)
            .await
            .expect("oneshot");
        let status = res.status();
        let bytes = res.into_body().collect().await.expect("body").to_bytes();
        (status, bytes.to_vec())
    }

    async fn send(state: &Arc<OhifServerState>, req: Request<Body>) -> (StatusCode, Vec<u8>) {
        send_scoped(state, req, "user/DocumentReference.cruds").await
    }

    fn get(uri: &str) -> Request<Body> {
        Request::builder().uri(uri).body(Body::empty()).unwrap()
    }

    #[tokio::test]
    async fn get_dicom_file_returns_raw_bytes() {
        let st = state();
        let (status, body) = send(&st, get("/api/dicom/files/doc-1")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, vec![0xDE, 0xAD, 0xBE, 0xEF]);
    }

    #[tokio::test]
    async fn get_dicom_file_not_found() {
        let st = state();
        let (status, _body) = send(&st, get("/api/dicom/files/no-such-id")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn read_403_without_the_document_reference_read_scope() {
        let st = state();
        let (status, body) =
            send_scoped(&st, get("/api/dicom/files/doc-1"), "wildflower/Accounts.r").await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let json: serde_json::Value = serde_json::from_slice(&body).expect("json");
        assert_eq!(json["error"], "InsufficientScope");
        assert_eq!(
            json["missingScopes"],
            serde_json::json!(["user/DocumentReference.r"]),
        );
    }

    #[tokio::test]
    async fn system_wildcard_scope_covers_the_user_document_reference_scope() {
        let st = state();
        let (status, body) =
            send_scoped(&st, get("/api/dicom/files/doc-1"), "system/*.cruds").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, vec![0xDE, 0xAD, 0xBE, 0xEF]);
    }

    #[tokio::test]
    async fn missing_claims_fails_closed_with_a_500() {
        let st = state();
        let res = router()
            .with_state(Arc::clone(&st))
            .oneshot(get("/api/dicom/files/doc-1"))
            .await
            .expect("oneshot");
        assert_eq!(res.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }
}
