# AGENTS.md — apps/wildflower-site

**wildflowerhealth.io**, the site: the assembly that publishes it and the
homepage at its root. Unlike the other product folders, nothing folded in here:
the two packages share no package built only for them. They live together
because they ship together, the assembly placing the homepage at `/` and every
other app's build at its section path.

## Packages

- [`wildflower-site-web`](./wildflower-site-web/README.md) — the assembly. It
  owns no UI: each section is built by the package that owns it, and this
  package copies those builds to their public URLs (`src/assembly.ts`, every
  `destPath` from `branding-core`'s `SECTION_PATHS`), adds the GitHub Pages
  `404.html` redirect, and is what `deploy-github-pages.yml` and
  `pr-preview.yml` publish. Each section is a workspace dependency, so
  `vp run pack` builds them before it.
- [`marketing-site-web`](./marketing-site-web/README.md) — the homepage at
  `/`: a first-person essay that links into each app, pinned to the dark
  scheme. Its `public/` carries the `CNAME` that keeps the custom domain, and
  the `versions.json` the Tauri release workflow writes.

## Rules

- **A section's path lives in `SECTION_PATHS`.** A new app gets a key there
  and a `siteSections` entry here; `assembly.test.ts` holds the two to each
  other and pins the literal paths.

## References

- [apps/AGENTS.md](../AGENTS.md) — product folders and the names a product takes
- [slices/branding/AGENTS.md](../../slices/branding/AGENTS.md) — `SECTION_PATHS` and the site chrome
