//! Generates the plugin's command permissions + ACL schema and registers the
//! native source trees so `tauri ios`/`tauri android` codegen links them into
//! the host app: the `ios/` Swift package and the `android/` Kotlin library.

const COMMANDS: &[&str] = &["open", "evaluate_js", "patch_window_text", "close"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .ios_path("ios")
        .build();
}
