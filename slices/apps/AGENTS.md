# AGENTS.md — slices/apps

App registry, hosting-tier escalation protocol, and the HTTP API for launching FHIR apps. Read the [self-hosted-apps README](./self-hosted-apps/README.md) before touching anything under `self-hosted-apps/`.

## Traps

- **`self-hosted-apps/` vendored builds are gitignored and unpinned.** The third-party app builds it serves are absent from a fresh clone and from CI; they are read live from an app-data directory at runtime. Don't assume they exist, and don't add code that requires them at build or test time. At host startup they're auto-synced into app-data (`sync_vendored_self_hosted_apps` in `apps-rust/src/seed.rs`): dev overwrite-mirrors the source tree every run, release copies-if-missing from the bundled resources — both no-op when the builds are absent.
- **The serving root is `<app-data>/self-hosted-apps/` (renamed from `installed-apps/`).** The host creates it at startup if absent; there is no longer any runtime rename of a pre-existing `installed-apps/` dir. `setup_self_hosted_app` / `SelfHostedAppContext` are the current names in `self-hosted-apps-rust`.
- **`self_hosted_apps` is no longer read-only.** The owner-gated `POST /apps` create endpoint is `multipart/form-data` discriminated on `provenance`: the self-hosted arm carries an uploaded `bundle` and inserts a `self_hosted_apps` row + its `home_screen` ordering row (auto-suffixed slug, allocated port); `DELETE /apps/{id}` removes non-seeded ones. The migration-seeded rows carry `seeded = 1` and stay delete-protected (`409 AppNotEditable`); `AppListEntry.removable` is the client-facing removability contract.
- **Storage is table-per-struct** (issue #350): standalone `cloud_apps` / `self_hosted_apps` tables (each with all its own columns), a `home_screen` table for the cross-kind ordering + `enabled` flag, and a `apps_view` SQL view for cross-kind reads. System apps have no table (metadata + launch URL compiled into `SYSTEM_APPS`). The store is diesel over the shared `persistence_rust::DieselPool`, migrated with embedded diesel migrations (`apps-rust/migrations/`). See [Apps Explanation](../../docs/Apps/Explanation.md) §"Data model".
- Each self-hosted app is served from **its own loopback origin** — per-origin isolation is the security boundary; don't collapse apps onto a shared origin.
- The committed `templates/<app-id>/<serve-path>.hbs` tree is embedded via `include_dir!` on the Rust side and rendered per request with Handlebars (the `apiOrigin` variable resolves per request provenance) — template/config changes need the Rust build to pick them up.
- The slice has a committed OpenAPI snapshot (`apps-rust/openapi/apps.openapi.json`); regenerate a stale one per the [OpenAPI Spec Drift How-To](../../docs/Effect/OpenAPI%20Spec%20Drift%20How-To.md).

## References

- [self-hosted-apps README](./self-hosted-apps/README.md) — vendoring model, per-origin serving, committed templates
