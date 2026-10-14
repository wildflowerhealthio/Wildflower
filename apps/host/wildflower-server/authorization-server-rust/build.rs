//! The authorization server embeds the authorization pages' build,
//! `apps/host/wildflower-server/authorization-server-web/dist`, with
//! `include_dir!` (see `src/http/routes/oauth/authorization_pages.rs`). Cargo
//! does not see that directory as an input on its own, so this script names
//! it: a new build of the pages recompiles the authorization server. Without
//! it there is nothing to embed, so the build stops here, saying how to make
//! one.

use std::path::Path;

fn main() {
    let dist = Path::new("../authorization-server-web/dist");
    println!("cargo::rerun-if-changed={}", dist.display());
    assert!(
        dist.join("consent.html").is_file(),
        "apps/host/wildflower-server/authorization-server-web/dist/consent.html is missing: build \
         the authorization pages first \
         (`vp run -F @wildflowerhealthio/authorization-server-web build`), or write a placeholder \
         with `scripts/ci/stub-embedded-bundles.sh authorization-server-web`"
    );
}
