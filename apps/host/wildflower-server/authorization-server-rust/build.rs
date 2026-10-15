//! The authorization server embeds the authorization pages' build,
//! `apps/host/wildflower-server/authorization-server-web/dist`, with
//! `include_dir!` (see `src/http/routes/oauth/authorization_pages.rs`). Cargo
//! does not see that directory as an input on its own, so this script names
//! it: a new build of the pages recompiles the authorization server. Without
//! a page to embed the build stops here, saying how to make one.

use std::path::Path;

fn main() {
    let dist = Path::new("../authorization-server-web/dist");
    println!("cargo::rerun-if-changed={}", dist.display());
    for page in ["consent.html", "device.html"] {
        assert!(
            dist.join(page).is_file(),
            "apps/host/wildflower-server/authorization-server-web/dist/{page} is missing: build \
             the authorization pages first \
             (`vp run -F @wildflowerhealthio/authorization-server-web build`), or write \
             placeholders with `scripts/ci/stub-embedded-bundles.sh authorization-server-web`"
        );
    }
}
