//! Generates the plugin's command permissions + ACL schema and registers the
//! `ios/` Swift package so `tauri ios build`/`dev` links it into the host app.
//!
//! No `android_path` is set on purpose: the native popup is iOS-only for now
//! (see the crate docs). On Android the host keeps the existing Tauri
//! `WebviewWindow` sniffer path, and this plugin's `open` returns
//! `UnsupportedPlatform`.

const COMMANDS: &[&str] = &["open"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .ios_path("ios")
        .build();
}
