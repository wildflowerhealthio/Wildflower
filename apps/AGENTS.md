# AGENTS.md — apps/

Apps compose slice packages. They handle runtime wiring, routing, user interaction, and platform-specific concerns.

## Rules

- No business logic in the app package itself (it belongs in a `-core` package: a slice's `<name>-core`, or a product folder's `<product>-core-js`)
- Always go through core interfaces and APIs — don't reach into a slice's internals from an app
- Use `slices/<name>/<name>-{web,node}` adapters when you need a platform-specific implementation; never re-implement an adapter in an app

## Product folders

An app that has packages built only for it lives with them in one folder per
product, `apps/<product>/`: [`relay`](./relay/AGENTS.md),
[`fhir-sync-pebble`](./fhir-sync-pebble/AGENTS.md),
[`watch-lifts`](./watch-lifts/AGENTS.md), [`lifting`](./lifting/AGENTS.md),
[`launcher`](./launcher/AGENTS.md), [`host`](./host/AGENTS.md),
[`medications`](./medications/AGENTS.md),
[`health-viewer`](./health-viewer/AGENTS.md),
[`importer`](./importer/AGENTS.md) and
[`synthetic-data`](./synthetic-data/AGENTS.md).
[`wildflower-site`](./wildflower-site/AGENTS.md) is a product folder for
grouping alone: the site assembly and the marketing homepage share no package
built only for them, but they ship together as wildflowerhealth.io. An app with
no packages of its own sits directly under `apps/` under its product's name:
`server-docs-web` and `ohif-viewer-web`.

Packages that came from one slice and belong together stay nested in a folder
for their group, as `apps/host/servers/`, `apps/host/unit-runner/` and
`apps/importer/anonymizer/` do; a lone package, or one from the product's
namesake slice, sits directly in the product folder.

### What folds in

A package folds into a product folder when that product is its only consumer:
check every `package.json` that depends on it, and every Rust crate that
depends on its Rust half.

- **A whole slice** folds in when nothing else uses any of it, in either
  language (`slices/lifting` → `apps/lifting/`, `slices/relay` → `apps/relay/`,
  Rust binary included).
- **Only a slice's TypeScript packages** fold in when one product is their only
  consumer but the slice's Rust half is composed into the server
  (`apps/host/wildflower-server-rust`) or another crate. The slice keeps its Rust crate,
  its AGENTS.md and any file both languages read: `slices/apps` keeps
  `apps-rust` while `apps-core-js` and `apps-react` sit in `apps/launcher/`. A
  cross-language contract then reads across folders by relative path, such as
  `apps-core-js`'s OpenAPI drift test reading
  `slices/apps/apps-rust/openapi/apps.openapi.json`, and the golden JSON
  `wildflower-server-core-js` shares with `background-server-service-rust`.
- **Shared packages never fold in.** Anything two products use stays in
  `slices/` or `global/` (`branding`, `telemetry`, `smart-app`, `gatekeeper`,
  `global/pebble`).

### Names

Everything that identifies the product takes the folder's name:

| What                                     | Name                                                                                                                                     | Lifting                                         |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Folder                                   | `apps/<product>/`                                                                                                                        | `apps/lifting/`                                 |
| The app's folder and npm package         | `<product>-web` (a Pebble watchapp: `<product>-watchapp`; a Rust binary: `<product>-server`; a store-shipped Tauri app: `<product>-app`) | `lifting-web`                                   |
| A folded `-core` package                 | `<name>-core-js`                                                                                                                         | `lifting-core-js`                               |
| Other folded packages                    | keep their names (`-react`, `-pkjs`, `-test`)                                                                                            | `lifting-react`                                 |
| Published path on the site               | `/<product>/` (`SECTION_PATHS` in `branding-core`)                                                                                       | `/lifting/`                                     |
| Homescreen tile id                       | `<product>`                                                                                                                              | `lifting`                                       |
| Dev tile id and `dev-app-ports.json` key | `<product>-dev`                                                                                                                          | `lifting-dev`                                   |
| OAuth client id                          | random, from `openssl rand -hex 16`                                                                                                      | `bdf9fc5c…`                                     |
| Sentry DSN build variable                | `VITE_SENTRY_DSN_<PACKAGE>`                                                                                                              | `VITE_SENTRY_DSN_LIFTING_APP` (not yet renamed) |

A client id is never a name: the host's loopback consent dialog shows the
client's registered `name`, and nothing looks an app up by its client id, so a
tile id and its client id are independent.

Ids that predate this, and the Sentry `app` tags, are tracked in
[#1042](https://github.com/wildflowerhealthio/Wildflower/issues/1042).

### Moving a product in

1. Move the folders (an app folder whose name the product folder takes moves
   aside first), then delete each moved package's `node_modules` and run
   `vp install`: install does not rewrite the relative symlinks a moved
   `node_modules` still holds.
2. Rename the packages, then every import, `vp run -F` filter and path:
   `pnpm-workspace.yaml` (`apps/<product>/*`), the root `vite.config.ts`
   test projects, `.github/workflows/*`, `apps/wildflower-site/wildflower-site-web/src/assembly.ts`,
   and every relative path inside a package that moved deeper.
3. The slice's AGENTS.md becomes the folder's umbrella `apps/<product>/AGENTS.md`,
   with a `CLAUDE.md` symlink beside it; `slices/AGENTS.md` notes that the
   product is not a slice.
4. Re-key what installs already hold with new migrations, never edits to
   shipped ones: an apps-rust migration for the tile and dev tile
   (`0017_rekey_lifting_app`) and a gatekeeper-rust migration for the clients
   and every table that names them (`0025_rekey_lifting_app_clients`).

## Dev-server ports

The first-party apps pin their vite dev server to a port from
`slices/apps/dev-app-ports.json`, keyed `<product>-dev`. For the apps that get
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
