# AGENTS.md — slices/apps

App registry, hosting-tier escalation protocol, and the HTTP API for launching FHIR apps. Read the [self-hosted-apps README](./self-hosted-apps/README.md) before touching anything under `self-hosted-apps/`.

## Traps

- **`self-hosted-apps/` vendored builds are gitignored and unpinned.** The third-party app builds it serves are absent from a fresh clone and from CI; they are read live from an app-data directory at runtime. Don't assume they exist, and don't add code that requires them at build or test time.
- Each self-hosted app is served from **its own loopback origin** — per-origin isolation is the security boundary; don't collapse apps onto a shared origin.
- The committed `templates/<app-id>/<serve-path>.hbs` tree is embedded via `include_dir!` on the Rust side and rendered per request with Handlebars (the `apiOrigin` variable resolves per request provenance) — template/config changes need the Rust build to pick them up.
- The slice has a committed OpenAPI snapshot (`apps-rust/openapi/apps.openapi.json`); regenerate a stale one per the [OpenAPI Spec Drift How-To](../../docs/Effect/OpenAPI%20Spec%20Drift%20How-To.md).

## References

- [self-hosted-apps README](./self-hosted-apps/README.md) — vendoring model, per-origin serving, committed templates
