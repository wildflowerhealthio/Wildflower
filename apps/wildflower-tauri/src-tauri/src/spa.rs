use axum::response::Html;

// Embedded at compile time so the bundle ships inside the binary: a
// runtime file read keyed off `CARGO_MANIFEST_DIR` resolves to the
// build machine's absolute path, which doesn't exist on an installed
// app, so external-browser OAuth/consent flows (served the `/_auth/*`
// shell) would degrade to the failure page in every production build.
// `include_str!` resolves relative to this source file; the single-file
// `build:single-web` bundle is produced before the crate compiles, so
// one embedded string covers the whole shell. A build that skipped the
// bundle step fails to compile here rather than shipping a broken app.
const SPA_INDEX_HTML: &str =
    include_str!("../../../wildflower-react/dist-single-web/index-single-web.html");

/// Router fallback that serves the embedded single-page-app shell for any
/// route the API didn't handle — the client-side router takes over from there.
pub async fn handle_serving_spa_html() -> Html<&'static str> {
    Html(SPA_INDEX_HTML)
}
