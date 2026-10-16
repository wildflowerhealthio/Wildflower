# AGENTS.md — apps/wildflower-site

**wildflowerhealth.io**, the site: the assembly that publishes it and the
homepage at its root. Unlike the other product folders, nothing folded in here:
the two packages share no package built only for them. They live together
because they ship together: the assembly places the homepage at the apex and
publishes every other app on its own origin, `https://<slug>.wildflowerhealth.io/`.

## Packages

- [`wildflower-site-web`](./wildflower-site-web/README.md) — the assembly. It
  owns no UI: each section is built by the package that owns it, and this
  package copies those builds into one site, each app in its slug's directory
  (`src/assembly.ts`, every `destPath` from `branding-core`'s `APP_SLUGS`),
  with the GitHub Pages `404.html` redirect. `pr-preview.yml` publishes that
  site as is; `deploy-github-pages.yml` splits it (`src/stage-published.ts`)
  into the apex site, with a redirect stub at each app's old path, and one
  site per app, pushed to its `wildflowerhealthio/<slug>-web` repository.
  Each section is a workspace dependency, so `vp run pack` builds them
  before it.
- [`marketing-site-web`](./marketing-site-web/README.md) — the homepage at
  `/`: a first-person essay that links into each app, pinned to the dark
  scheme. Its `public/` carries the `CNAME` that keeps the custom domain, and
  the `versions.json` the Tauri release workflow writes.

## Rules

- **An app's slug lives in `APP_SLUGS`.** A new app gets a key there, a
  `siteSections` entry and an `APEX_REDIRECT_PATHS` entry (its slug) here, a repository
  in `deploy-github-pages.yml`'s token step, and the one-time setup of its
  `wildflowerhealthio/<slug>-web` repository (Pages from `gh-pages`, its
  custom domain, the DNS record and the deploy App's access). The tests hold
  the layout, the redirects and the workflow to `APP_SLUGS`.

## References

- [apps/AGENTS.md](../AGENTS.md) — product folders and the names a product takes
- [slices/branding/AGENTS.md](../../slices/branding/AGENTS.md) — `APP_SLUGS` and the site chrome
