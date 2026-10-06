# AGENTS.md — slices/apps

App registry and the HTTP API for launching FHIR apps.

## Traps

- **Storage is the one `app_registrations` table**: one row per app holding the global id, the catalogue fields, the launch `url` template, and the homescreen placement `position`/`on_homescreen`. See [Apps Explanation](../../docs/Apps/Explanation.md) §"Data model".
- **Domain shape**: the store and domain deal only in `AppRegistration` — the whole app, both the diesel-mapped row and the wire item every route returns. The write methods take a caller-built registration and persist only the editable subset (the capabilities synthesize it); `find_app` returns the registration, which the launch handler renders through `resolve_launch` (a free fn in `http/routes/apps/launch.rs`). `is_smart` is derived from the host-only `client_id`.
- **Route table**: `GET /apps` → `AppRegistration[]` (includes hidden); `POST /apps` → create; `GET`/`PUT`/`DELETE /apps/{id}` → read / content replace / delete (204); `POST /apps/{id}` → launch; `PUT /home-screen` → atomic reorder + `onHomescreen` (the store's `replace_placements`).
- **Wire keys**: the registration serializes `onHomescreen` (the placement flag), `url` (the launch template), and `isSmart` (derived from the host-only `client_id`). `position` never leaves the host (the `GET /apps` array order is the display order).
- **Ports-and-adapters store** (mirrors collector): see the [Apps Store Explanation](../../docs/Apps/Store%20Explanation.md) §"Ports and adapters". The admin HTTP handlers acquire a `Scoped<…>` capability (`domain/capabilities/`, one per operation) and never touch the store directly — the launch handler reads the store itself and uses `AppLauncher` for the umbrella and per-app scope checks; the capabilities own the semantic `AppsError` mapping and are unit-tested against the in-memory `FakeAppsStore` (`domain/test_fake.rs`). Migrations run under this slice's diesel namespace (`"apps"`), so its `0001` never collides with another diesel slice's `0001`.
- The slice has a committed OpenAPI snapshot (`apps-rust/openapi/apps.openapi.json`); regenerate a stale one per the [OpenAPI Spec Drift How-To](../../docs/Effect/OpenAPI%20Spec%20Drift%20How-To.md).
