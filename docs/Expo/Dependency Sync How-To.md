# Dependency Sync How-To

How to keep Expo and React Native dependencies aligned across this monorepo so every Expo app passes `npx expo-doctor` and libraries declare honest peer ranges.

## The Three Rules

1. **Versions live in `pnpm-workspace.yaml`'s `catalog:`.** Every shared Expo/RN dep — `expo`, `expo-*`, `react`, `react-native`, `react-native-*`, `@react-navigation/*`, `@expo/*`, `babel-preset-expo`, etc. — has exactly one version specifier, in the workspace catalog.
2. **`dependencies` and `devDependencies` use `"catalog:"`.** Packages reference the catalog instead of pinning their own version. This guarantees the same `expo-image` everywhere — no duplicate native modules.
3. **Library `peerDependencies` use `">=<major>.0.0"`.** Libraries declare the floor they need, not the exact version they were tested against. For 0.x packages, the effective major is the minor — `react-native@0.83.6` → `">=0.83.0"`, `@effect/platform@0.93.8` → `">=0.93.0"`.

## Add a New Expo or RN Dependency

1. Add the version to `catalog:` in `pnpm-workspace.yaml`. Pick the version Expo SDK wants — `npx expo install --check` in any Expo app prints what the SDK expects for installed packages, and the SDK changelog covers anything new.
2. Add `"<dep>": "catalog:"` to the consuming package's `dependencies` (or `devDependencies`).
3. If the consumer is a library that re-exports the dep's types or uses its API in its public surface, also add `"<dep>": ">=<major>.0.0"` to `peerDependencies`.
4. Run `vp install` from the repo root.
5. Validate (see below).

## Validate

```bash
# In every Expo app (apps/wildflower, global/expo-effect-platform/example):
npx expo-doctor

# In every library and elsewhere:
vp check
```

`expo-doctor` should report `18/18 checks passed`. The two checks that matter most for dependency sync:

- **"Check that no duplicate dependencies are installed"** — fails when the same native module resolves to multiple versions. Almost always means a transitive dep wants a newer patch than a direct dep is pinning.
- **"Check that packages match versions required by installed Expo SDK"** — fails when a catalog version is older than what the current SDK expects. Bump the catalog entry.

For libraries, `vp check` runs format, lint, and typecheck. Peer ranges are not enforced at typecheck time, but a wrong floor still surfaces if the API surface changes between versions.

## Bind a Transitive Dep with the Catalog

If a transitive dep resolves to a version older than what the catalog declares, no consumer is binding the catalog. Add it as a direct dep on the package that needs it.

Example: `expo-router` requires `@expo/metro-runtime@^55.0.10` but pnpm resolved `55.0.7`. Fix:

```json
// apps/wildflower/package.json
"dependencies": {
  "@expo/metro-runtime": "catalog:",
  ...
}
```

The catalog entry binds only when at least one workspace package declares the dep with `"catalog:"`.

## Bumping the Patch Floor

When `expo-doctor` reports patch mismatches:

```text
package           expected  found
expo-image        ~55.0.9   55.0.6
expo-asset        ~55.0.16  55.0.10
...
```

Update the catalog values to the `expected` column, then `vp install`. Don't pin per-package — that defeats the catalog.

## Why These Rules

- **Single source of version truth** — bumping a dep is one edit, not N. Drift is impossible because there is no second place for a version to drift to.
- **Loose peer ranges** — libraries declare the floor they need, not the version they happened to be tested with. Apps choose the exact version through the catalog. A library that pins `expo: "~55.0.18"` in peers blocks any consumer on `~55.0.19` from installing without warnings.
- **Tilde in catalog, `>=` in peers** — the catalog uses `~` (or exact) so apps stay on the SDK's expected patch. Peers use `>=` because libraries don't care about patch — they care about the floor of the API surface.

## Adding a New Expo Library Package

A new library (e.g., `global/expo-foo`) that uses Expo APIs:

1. `dependencies` is for things bundled into the build — usually empty for a pure library. Use `devDependencies` for build-time tools.
2. `devDependencies` mirrors what the library imports for type-checking and tests, all using `"catalog:"`.
3. `peerDependencies` declares the runtime contract: anything the library imports that a consumer is expected to provide (Expo SDK packages, React, React Native, Effect). Use `">=<major>.0.0"`.
4. Make sure `peerDependencies` is a subset of `devDependencies` — if a peer isn't installable in dev, the library can't be type-checked.

## Further Reading

- [pnpm catalog protocol](https://pnpm.io/catalogs) — How `catalog:` resolves
- [Expo SDK 55 install instructions](https://docs.expo.dev/get-started/installation/) — What the SDK expects
- [`npx expo-doctor`](https://docs.expo.dev/develop/development-builds/installation/#expo-doctor) — The validation tool
