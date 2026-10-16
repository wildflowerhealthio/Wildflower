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
  keeps the custom domain, and the `versions.json` the Tauri release workflow
  writes.

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
  `APP_SITES` entry in `scripts/ci/pages-sites.ts`, an `APEX_REDIRECT_PATHS`
  entry (its slug) in `marketing-site-web`, and the one-time setup of its
  `wildflowerhealthio/<slug>-web` repository (Pages from `gh-pages` at `/`,
  its custom domain, the DNS record and the deploy App's access). The tests
  hold the sites and the redirects to `APP_SLUGS`.

## References

- [apps/AGENTS.md](../AGENTS.md) — product folders and the names a product takes
- [slices/branding/AGENTS.md](../../slices/branding/AGENTS.md) — `APP_SLUGS`, the site chrome and the 404 redirect
