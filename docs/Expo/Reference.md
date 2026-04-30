# Expo Reference

Gotchas and conventions for Expo apps and modules in this monorepo. For dependency-version rules, see the [Dependency Sync How-To](./Dependency%20Sync%20How-To.md).

## App config: deprecated SDK 55 keys

These keys are valid in SDK 54 and earlier; SDK 55 removed them because the behavior became default. `expo-doctor` schema check fails on them.

| Key                         | Status in SDK 55                         | Action                 |
| --------------------------- | ---------------------------------------- | ---------------------- |
| `newArchEnabled`            | Removed; New Architecture is the default | Delete from `app.json` |
| `android.edgeToEdgeEnabled` | Removed; edge-to-edge is the default     | Delete from `app.json` |

The keys are ignored at runtime, so the failure is hygiene, not breakage. Scrub them when bumping the catalog past SDK 54.

## Metro config: trust the defaults in workspace examples

`expo/metro-config` (SDK 53+) auto-detects pnpm workspaces — it walks up to find `pnpm-workspace.yaml`, then sets `watchFolders` and `resolver.nodeModulesPaths` to the workspace root. Manually overriding those values _replaces_ (not extends) the defaults, which is exactly what `expo-doctor`'s metro check flags ("watchFolders does not contain all entries from Expo's defaults").

For an example app under `global/<package>/example`, the minimal correct config is:

```js
const { getDefaultConfig } = require('expo/metro-config')
const path = require('path')

const config = getDefaultConfig(__dirname)

config.resolver.extraNodeModules = {
  '<parent-package-name>': path.resolve(__dirname, '..'),
}

module.exports = config
```

Only `extraNodeModules` is needed — to alias `import '<parent-package-name>'` from the example to the parent directory. Everything else (`watchFolders`, `nodeModulesPaths`, `blockList`, `getTransformOptions`) is auto-handled.

The deduplication rationale that the `expo-modules-create` template comments about ("npm v7+ will install ../node_modules/react...") was for non-workspace setups under npm. With the catalog protocol enforced (see [Dependency Sync How-To](./Dependency%20Sync%20How-To.md)), every consumer in the monorepo resolves to the same `react` and `react-native` — there is no second copy to block.

## Native module autolinking from a workspace example

A `global/<package>/example` app discovers the parent module via:

```json
"expo": {
  "autolinking": {
    "nativeModulesDir": ".."
  }
}
```

in `example/package.json`. This points `expo-modules-autolinking` at the parent directory so it picks up the parent's `expo-module.config.json` and links the native iOS/Android sources. Required even when the JS side is aliased through `extraNodeModules` — JS resolution and native linking are independent paths.

## Reaching the dev machine from a device

Hard-coded `localhost` (iOS sim) / `10.0.2.2` (Android emulator) doesn't work on physical devices and breaks anytime the dev server isn't on the same loopback. Use Expo's host URI instead:

```ts
import Constants from 'expo-constants'

const HOST_URI = Constants.expoConfig?.hostUri ?? Constants.expoGoConfig?.debuggerHost
const LOCAL_HOST = HOST_URI?.split(':')[0] ?? 'localhost'
```

`hostUri` is the address the device is currently using to reach the Metro bundler — same address the dev machine listens on for everything else. Falls back cleanly in production builds.

## `expo-doctor` checks worth understanding

`npx expo-doctor` runs 18 checks. Two are load-bearing for dependency hygiene (covered in [Dependency Sync How-To](./Dependency%20Sync%20How-To.md)):

- **"Check that no duplicate dependencies are installed"** — duplicate native modules at install time. Almost always a transitive pin newer than a direct pin in the catalog.
- **"Check that packages match versions required by installed Expo SDK"** — catalog version older than what the SDK expects. Bump the catalog entry.

The other commonly-failing two are config drift, covered above:

- **"Check Expo config schema"** — `app.json` has keys the current SDK doesn't recognize.
- **"Check for issues with Metro config"** — overrides that replace defaults instead of extending them.

`expo-doctor` is the canonical signal for "is this Expo app set up cleanly." Run it after any catalog bump or new-package addition.

## Vite+ vs. Expo CLI

Vite+ owns lint/format/typecheck/test/pack across the monorepo. Expo CLI owns native builds, bundling for the device, and dev-server orchestration.

- Use `vp check` and `vp test` for the JS layer of an Expo module.
- Use `npx expo run:ios` / `npx expo run:android` / `npx expo start` from the example app for native and device work.
- Never run `npx expo install` against the catalog — it pins versions in `package.json`. Update `pnpm-workspace.yaml`'s `catalog:` instead, then `vp install`.

## Further Reading

- [Dependency Sync How-To](./Dependency%20Sync%20How-To.md) — Catalog rules, `peerDependencies` floors, validation
- [Expo SDK config reference](https://docs.expo.dev/versions/latest/config/app/) — Full `app.json` schema
- [Customizing Metro](https://docs.expo.dev/guides/customizing-metro/) — Metro's auto-detection behavior
