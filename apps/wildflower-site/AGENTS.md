# AGENTS.md — apps/wildflower-site

**wildflowerhealth.io**, the apex of the site: the marketing homepage and the
policy pages. Every hosted app is published on an origin of its own,
`https://<slug>.wildflowerhealth.io/`, by its own deploy; this folder holds
only what the apex serves.

## Packages

- [`marketing-site-web`](./marketing-site-web/README.md) — the homepage at
  `/`: a first-person essay that links into each app, pinned to the dark
  scheme, plus the policy pages and a redirect page at each app's old apex
  path (`src/app-redirects.ts`, written into the build by
  `scripts/write-apex-pages.ts`). Its `public/` carries the `CNAME` that
  keeps the custom domain, the `versions.json` the Tauri release workflow
  writes, and `suggested_apps.json`, the SMART apps worth trying with a
  Wildflower server, hand-edited, whose schema is `suggested-apps-core-js`.
- [`code-index-web`](./code-index-web/README.md) — the code index at
  `/code-index/`: every crate and TS package, each with its files and items,
  their doc comments, a what-uses-what graph and simplification hints,
  extracted from rust-analyzer's SCIP index and the TypeScript checker. Built
  on `main` only, by `deploy-github-pages.yml`'s `code-index` job, into the
  marketing build.
- [`book-web`](./book-web/README.md) — the book at `/book/`: the code read in
  domain order, mdbook chapters kept in `docs/Book/` beside the code they
  explain, with `{{#code}}` directives that inline source by file and symbol
  at build time. Built by `deploy-github-pages.yml`'s `book` job into the
  marketing build, and into the marketing site's PR previews.
- [`suggested-apps-core-js`](./suggested-apps-core-js/) — the schema of
  `suggested_apps.json`. The site is its only consumer, decoding its file
  with it in a test.

## Publishing

`.github/workflows/deploy-github-pages.yml` publishes on every push to
`main`: each hosted app to the root of the `gh-pages` branch of its own
repository, `wildflowerhealthio/<slug>-web`, through the reusable
`deploy-pages-site.yml`, then this site's build to the apex through this
repository's Pages. `pr-preview.yml` previews each site a PR affects in
`pr-<n>/` of the same branch (`https://<slug>.wildflowerhealth.io/pr-<n>/`;
this site's in `pr-<n>/` of `wildflowerhealthio/staging`) and removes the
previews when the PR closes. `scripts/ci/pages-sites.ts` names the sites,
and `scripts/ci/publish-pages-branch.sh` writes a branch without touching the
other deploys' parts of it. The `404.html` every site serves is
`branding-core`'s `github-pages/404.html`.

## Rules

- **An app's slug lives in `APP_SLUGS`.** A new app gets a key there, an
  `APP_SITES` entry in `scripts/ci/pages-sites.ts` (with `requiredFiles` when
  its build must hold more than `index.html`, as the App Catalog's `apps` and
  `apps.json`), an `APEX_REDIRECT_PATHS`
  entry (its slug) in `marketing-site-web`, and the one-time setup of its
  `wildflowerhealthio/<slug>-web` repository (Pages from `gh-pages` at `/`,
  its custom domain, the DNS record and the deploy App's access). The tests
  hold the sites and the redirects to `APP_SLUGS`.

## References

- [apps/AGENTS.md](../AGENTS.md) — product folders and the names a product takes
- [slices/branding/AGENTS.md](../../slices/branding/AGENTS.md) — `APP_SLUGS`, the site chrome and the 404 redirect
