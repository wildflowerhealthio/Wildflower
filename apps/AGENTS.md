# AGENTS.md — apps/

Apps compose slice packages. They handle runtime wiring, routing, user interaction, and platform-specific concerns.

## Rules

- No business logic in the app package itself (it belongs in a `-core` package: a slice's `<name>-core`, or a product folder's `<product>-core-js`)
- Always go through core interfaces and APIs — don't reach into a slice's internals from an app
- Use `slices/<name>/<name>-{web,node}` adapters when you need a platform-specific implementation; never re-implement an adapter in an app

## Product folders

An app that has packages built only for it lives with them in one folder per
product, `apps/<product>/`: [`app-catalog`](./app-catalog/AGENTS.md),
[`authorization`](./authorization/AGENTS.md),
[`relay`](./relay/AGENTS.md),
[`fhir-sync-pebble`](./fhir-sync-pebble/AGENTS.md),
[`watch-lifts`](./watch-lifts/AGENTS.md), [`strength`](./strength/AGENTS.md),
[`launcher`](./launcher/AGENTS.md), [`host`](./host/AGENTS.md),
[`medications`](./medications/AGENTS.md),
[`plots`](./plots/AGENTS.md) and
[`synthetic-data`](./synthetic-data/AGENTS.md).
[`wildflower-site`](./wildflower-site/AGENTS.md) holds the marketing
homepage, which ships at the apex of wildflowerhealth.io. An app with
no packages of its own sits directly under `apps/` under its product's name:
`server-docs-web`, `ohif-viewer-web` and `importer-web`, whose importer and
anonymizer packages are slices (`slices/importer`, `slices/anonymizer`).

Packages that came from one slice and belong together stay nested in a folder
for their group, as `apps/host/servers/`, `apps/host/unit-runner/` and
`apps/launcher/databases/` do (each group also
listed in `pnpm-workspace.yaml` and the root `vite.config.ts` test projects);
a lone package, or one from the product's
namesake slice, sits directly in the product folder.

### What folds in

A package folds into a product folder when that product is its only consumer:
check every `package.json` that depends on it, and every Rust crate that
depends on its Rust half.

- **A whole slice** folds in when nothing else uses any of it, in either
  language (`slices/lifting` → `apps/strength/`, `slices/relay` → `apps/relay/`,
  Rust binary included).
- **A slice splits by language** when one product is the only consumer of its
  TypeScript packages and the host the only consumer of its Rust crates. The
  TypeScript packages fold into that product, in a folder named for the slice,
  with the slice's AGENTS.md and docs when it has them
  (`apps/launcher/databases/`); the crates
  fold into [`apps/host/wildflower-server/`](./host/wildflower-server/AGENTS.md)
  beside the server that composes them. No slice may depend on a folded crate,
  not even as a dev-dependency: a test that drives two slices together moves
  into `wildflowerhealthio-wildflower-server`'s tests.
- **Only a slice's Rust crates** fold in when the host is their only consumer
  but other products share the slice's TypeScript packages. The crates move to
  `apps/host/wildflower-server/`, with the docs about them; the slice keeps its
  TypeScript packages, its AGENTS.md and the shared docs: `authorization-server-rust` and
  `token-revocation-rust` left `slices/authorization`, and `fhir-r4-rust` left
  `slices/fhir`. A crate another product also uses stays behind, as
  `rathole-settings-rust`, which the relay shares, stayed when `tunnel-rust`
  moved.
- Either way, a cross-language contract then reads across folders by relative
  path, such as `apps-core-js`'s OpenAPI drift test reading
  `apps/host/wildflower-server/apps-rust/openapi/apps.openapi.json`, or `request-log-core-js`'s
  reading `apps/host/wildflower-server/request-log-rust/openapi/request-log.openapi.json`.
- **Shared packages never fold in.** Anything two products use stays in
  `slices/` or `global/` (`branding`, `telemetry`, `smart-app-react`,
  `authorization-core`, `global/pebble`); a file every app reads sits at the repo
  root (`dev-app-ports.json`).

### Names

Everything that identifies the product takes the folder's name. Every npm
package is scoped `@wildflowerhealthio/`; every other identifier uses the
unscoped name:

| What                                       | Name                                                                                                                                     | Medications                           |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Folder                                     | `apps/<product>/`                                                                                                                        | `apps/medications/`                   |
| The app's folder                           | `<product>-web` (a Pebble watchapp: `<product>-watchapp`; a Rust binary: `<product>-server`; a store-shipped Tauri app: `<product>-app`) | `medications-web`                     |
| The app's npm package                      | `@wildflowerhealthio/<folder>`                                                                                                           | `@wildflowerhealthio/medications-web` |
| Rust crate (and binary)                    | `wildflowerhealthio-` + its folder's name, less a trailing `-rust`                                                                       | `wildflowerhealthio-relay-server`     |
| A folded `-core` package                   | `<name>-core-js`                                                                                                                         | `medication-interaction-core-js`      |
| Other folded packages                      | keep their names (`-react`, `-pkjs`, `-test`)                                                                                            | `medication-calendar-react`           |
| Published origin                           | `https://<product>.wildflowerhealth.io/` (`APP_SLUGS` in `branding-core`)                                                                | `medications.wildflowerhealth.io`     |
| Homescreen tile id                         | `<product>`                                                                                                                              | `medications`                         |
| Dev tile id and `dev-app-ports.json` key   | `<product>-dev`                                                                                                                          | `medications-dev`                     |
| OAuth client id                            | random, from `openssl rand -hex 16`                                                                                                      | `9769f8b2…`                           |
| Sentry DSN build variable                  | `VITE_SENTRY_DSN_<PACKAGE>`                                                                                                              | `VITE_SENTRY_DSN_MEDICATIONS_WEB`     |
| Sentry `app` tag and OpenTelemetry service | the unscoped package name                                                                                                                | `medications-web`                     |

A client id is never a name: the consent prompts show the client's registered
`name`, and nothing looks an app up by its client id, so a tile id and its
client id are independent.

A crate's name carries the `wildflowerhealthio-` prefix because crates.io has
no namespaces; it stands in for the npm scope. The folder keeps `-rust`, which
tells a slice's Rust half from its TypeScript half side by side, but the crate
drops it (crates are Rust by definition), so `slices/scopes/scopes-rust` is
the crate `wildflowerhealthio-scopes`. Some crates keep other names because
Tauri derives something from them: the `tauri-plugin-*` plugins
(`tauri-plugin-native-webview`, `tauri-plugin-native-page-browser`; a plugin
crate needs the `tauri-plugin-` prefix) and the host's `host-app` (Tauri
names the iOS Xcode project and scheme, `gen/apple/host-app.xcodeproj`, the
binary and the Linux AppImage after the package). No crate is published: the
workspace sets `publish = false`.

An app's path on the apex, `https://wildflowerhealth.io/<product>/`, serves
only a redirect to its origin (`APEX_REDIRECT_PATHS` in `marketing-site-web`).
Two are off the pattern: Plots' is `/health-viewer/` and Strength's
`/lifting/`.

### Moving a product in

1. Move the folders (an app folder whose name the product folder takes moves
   aside first), then delete each moved package's `node_modules` and run
   `vp install`: install does not rewrite the relative symlinks a moved
   `node_modules` still holds.
2. Rename the packages, then every import, `vp run -F` filter and path:
   `pnpm-workspace.yaml` (`apps/<product>/*`), the root `vite.config.ts`
   test projects, `.github/workflows/*`, `scripts/ci/pages-sites.ts`,
   and every relative path inside a package that moved deeper.
3. The slice's AGENTS.md becomes the folder's umbrella `apps/<product>/AGENTS.md`,
   with a `CLAUDE.md` symlink beside it; `slices/AGENTS.md` notes that the
   product is not a slice.
4. Re-key what installs already hold with new migrations, never edits to
   shipped ones: an apps-rust migration for the tile and dev tile
   (`0017_rekey_lifting_app`) and a authorization-server-rust migration for the clients
   and every table that names them (`0025_rekey_lifting_app_clients`).

## Dev-server ports

The first-party apps pin their vite dev server to a port from
`dev-app-ports.json`, keyed `<product>-dev`. For the apps that get
a debug-only "(Dev)" homescreen tile, `apps-rust/src/dev_seed.rs` embeds it to
seed the matching row; the launcher has no tile, and `host-app`'s `build.rs`
reads its `launcher-dev` port instead. `devAppServer(id)`
in the root [`vite.config.base.ts`](../vite.config.base.ts) is the **only**
TypeScript reader of that file — spread it into `server` (or `preview`) instead
of parsing the JSON again:

```ts
import base, { devAppServer } from '../../../vite.config.base.ts'

export default defineConfig({
  ...base,
  server: devAppServer('medications-dev'),
})
```

The helper narrows `id` to the file's own keys, so a new app gets its port by
adding a row to the JSON (and to `dev_seed.rs`), not by hand-rolling a reader.

## References

- [Architecture / slice layering](../slices/AGENTS.md) — How slices are layered
- [Effect Patterns Reference](../docs/Effect/Patterns%20Reference.md) — Layer composition and Tag wiring
