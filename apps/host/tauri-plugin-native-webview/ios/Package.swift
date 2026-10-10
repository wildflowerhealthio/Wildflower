// swift-tools-version:5.3
import PackageDescription

let package = Package(
  name: "tauri-plugin-native-webview",
  platforms: [
    .iOS(.v13)
  ],
  products: [
    // The static library Tauri links into the host iOS app at `tauri ios`
    // codegen time (the `links`/`ios_path` wiring in Cargo.toml + build.rs).
    .library(
      name: "tauri-plugin-native-webview",
      type: .static,
      targets: ["tauri-plugin-native-webview"])
  ],
  dependencies: [
    // Resolved by Tauri's iOS codegen to the generated Tauri Swift API package.
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-native-webview",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
