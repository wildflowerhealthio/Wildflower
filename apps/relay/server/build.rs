//! The relay embeds the admin UI's build, `apps/relay/admin-web/dist`, with
//! `include_dir!` (see `src/site/admin_ui.rs`). Cargo does not see that
//! directory as an input on its own, so this script names it: a new build of
//! the UI recompiles the relay. Without it there is nothing to embed, so the
//! build stops here, saying how to make one.

use std::path::Path;

fn main() {
    let dist = Path::new("../admin-web/dist");
    println!("cargo::rerun-if-changed={}", dist.display());
    assert!(
        dist.join("index.html").is_file(),
        "apps/relay/admin-web/dist/index.html is missing: build the admin UI first \
         (`vp run -F relay-admin-web build`), or write a placeholder with \
         `scripts/ci/stub-embedded-bundles.sh relay-admin-web`"
    );
}
