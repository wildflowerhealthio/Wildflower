# AGENTS.md — apps/app-catalog

The **App Catalog**: Wildflower's
[HALO 2.0.0-DFT-preBallot App Catalog](https://simplifier.net/guide/halo/Home/HALO-Components/App-Catalog),
the SMART on FHIR apps worth trying with a Wildflower server, published at
`https://app-catalog.wildflowerhealth.io/apps`. The catalog is not a SMART
app: it has no OAuth client, no homescreen tile and no dev tile.

## Packages

- **`app-catalog-core-js`** (pure) — the `AppCatalog` namespace: the HALO
  application object as Effect Schema (`App`, told apart by its `type`: a
  `SmartApp` with its `launchUrl`, or a `BackendService` with its onboarding
  endpoints; with their `Contact`, `Publisher`, `PreassignedCredentials` and
  `Intent`), each of HALO's conditional rules a filter naming the rule, the
  document (`Catalog`, no two apps sharing an `id`), the closed `Tag` list with its `TAG_LABELS`, and
  where the catalog is published (`CATALOG_PATH`, `CATALOG_JSON_PATH`,
  `CATALOG_URL`). No React, no DOM.
- **`app-catalog-web`** — the site at the catalog's origin. Its
  `public/apps.json` is the catalog, hand-edited; the build publishes it as
  both `/apps` and `/apps.json`. See its [README](./app-catalog-web/README.md).

## Rules

- **The catalog is a committed file, decoded by a test.** Every edit goes
  through `public/apps.json`; `src/catalog.test.ts` holds Wildflower
  Health's entries to `branding-core`, and `authorization-server-rust`'s
  `app_catalog_preassigns_wildflower_health_clients_as_seeded` holds each of
  their `preassignedCredentials` to the client its migrations seed.
- **A page reads the catalog from `/apps`**, as any HALO client does; nothing
  bundles a copy of it.

## References

- [apps/AGENTS.md](../AGENTS.md) — product folders and the names a product takes
- [apps/wildflower-site/AGENTS.md](../wildflower-site/AGENTS.md) — how each hosted app is published
