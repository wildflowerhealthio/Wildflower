// swift-tools-version:5.3
import PackageDescription

let package = Package(
  name: "tauri-plugin-native-page-browser",
  platforms: [
    .iOS(.v13)
  ],
  products: [
    // The static library Tauri links into the host iOS app at `tauri ios`
    // codegen time (the `links`/`ios_path` wiring in Cargo.toml + build.rs).
    .library(
      name: "tauri-plugin-native-page-browser",
      type: .static,
      targets: ["tauri-plugin-native-page-browser"])
  ],
  dependencies: [
    // Resolved by Tauri's iOS codegen to the generated Tauri Swift API package.
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-native-page-browser",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
