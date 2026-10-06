//! The FHIR R4 store's readiness check, asked in-process, passes on the store
//! `setup_fhir_r4` opened and keeps passing while the router serves it.

use std::path::PathBuf;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use emr_rust::{setup_fhir_r4, EmrConfig};
use shared_structures_rust::ServerRuntimeConfig;
use tower::ServiceExt;

#[tokio::test]
async fn the_store_readiness_check_passes_on_an_open_store() {
    let dir = tempfile::tempdir().expect("temp dir");
    let runtime = ServerRuntimeConfig {
        loopback_base_url: "http://127.0.0.1:8080".parse().expect("parse loopback url"),
        server_dir: dir.path().to_owned(),
    };
    let config = EmrConfig {
        log_level: "error".to_string(),
        db_file_path: dir.path().join("health-data.sqlite"),
        jwks_url: None,
        search_parameter_data_dir: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("assets"),
        public_origin: "https://abc.relay.example"
            .parse()
            .expect("parse public origin"),
    };
    let routers = setup_fhir_r4(
        &runtime,
        &config,
        token_revocation_rust::RevocationStore::always_allow(),
    )
    .expect("setup_fhir_r4");

    routers
        .store_readiness
        .check()
        .await
        .expect("a freshly opened store is ready");

    // The router HFS serves the store through agrees, and the check still
    // passes after a request has used the store.
    let readiness = routers
        .augmented_fhir_r4_router
        .oneshot(
            Request::builder()
                .uri("/fhir-r4/_readiness")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("infallible");
    assert_eq!(readiness.status(), StatusCode::OK);
    routers
        .store_readiness
        .check()
        .await
        .expect("the store is still ready");
}
