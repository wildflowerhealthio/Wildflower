# AGENTS.md — apps/relay/relay-admin-web

The tunnel relay's admin page. The relay
([`apps/relay/relay-server`](../relay-server), `wildflower-relay`) embeds this package's
build in its binary and serves it at `https://admin.<domain>/`, the same
origin as the admin API it calls, so there is no CORS and no sign-in on the
relay: the page signs each request with the admin key. Everything it shows
is [`relay-react`](../AGENTS.md)'s `RelayAdminScreen`.

`apps/watch-lifts/watch-lifts-web` is the template for the shape (one `index.html`
entry, a build into the package's own `dist/`). What differs: the page is
served at the site root (`base: '/'`), and nothing is inlined, because of
the relay's Content Security Policy (below).

## Layout

- `main.tsx` — builds the runtime (`RelayAdminHttpApiClient` over
  `signingHttpClient(location.origin)` over `fetch`, with the key in
  `relay-react`'s `adminKeyStoreIndexedDb`) and mounts the screen.
- `vite.config.ts` — `base: '/'` and `assetsInlineLimit: 0`.

## Using it

The operator opens `https://admin.<domain>/` and pastes
`WILDFLOWER_RELAY_ADMIN_KEY` once. The browser keeps a non-extractable signing
key made from it in IndexedDB until Sign out. The page then lists the tunnels
(name, public host, owner's email, creation date), creates one for an email
under a given or relay-picked name and shows its token once, and deletes one
after a confirmation. If the relay answers `401`, the key is wrong or the
device's clock is more than a minute off the relay's; the page drops the key
and asks for it again.

## Traps

- **The relay serves every file under
  `Content-Security-Policy: default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`.**
  No inline `<script>` or `<style>`, no `style="…"` in markup, no `data:`
  URLs, nothing from another origin. Vite's output (a module script, a
  stylesheet and the fonts, all under `assets/`) fits; keep it that way.
- **`dist/` is embedded at compile time.** `cargo build -p wildflowerhealthio-relay-server`
  needs it: run `vp build` here first, or
  `scripts/ci/stub-embedded-bundles.sh relay-admin-web` for a placeholder. The
  relay's `build.rs` rebuilds the crate when `dist/` changes.
- **The admin API is same-origin only.** `vp dev` serves the page but has no
  relay behind it, so any API call fails; the screen's behaviour is covered
  by `relay-react`'s tests against an in-memory relay.

## References

- [apps/relay AGENTS.md](../AGENTS.md) — the core and the screen
- `apps/relay/relay-server/src/site/admin_ui.rs` — how the relay serves the build
- `.github/workflows/deploy-relay.yml` — builds this, then the relay
