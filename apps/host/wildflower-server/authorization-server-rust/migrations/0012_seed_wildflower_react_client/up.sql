-- Seed the OAuth client for the **statically hosted** Wildflower owner UI — the
-- `main-web` build of `apps/wildflower-react`, which runs cross-origin to
-- whichever server the user points it at and holds its bearer in page memory
-- (`gatekeeper-react`'s `bearer-auth-state-store.ts`). A public PKCE client: it
-- is a static browser page, so it can keep no secret and `secret_hash` stays
-- NULL. Same pattern and column formats as
-- 0007_seed_wildflower_server_docs_client (see `db/clients.rs`).
--
-- WHY A CLIENT OF ITS OWN, and not the first-party `wildflower-host`. The host
-- client is seeded from code on every boot with NO redirect URIs at all
-- (`seeding.rs`'s `ensure_first_party_client`), and it is the one client
-- `/oauth/authorize` refuses to trust on first use: an unregistered
-- `redirect_uri` for it renders the local `RedirectUriNotAllowed` page instead of
-- reaching the Owner's consent prompt (`http/routes/oauth/authorize.rs`). That is
-- correct — the host client's credential is the desktop app's own — but it makes
-- it unusable for a browser page doing an authorization-code redirect. A separate
-- non-first-party row gets the ordinary trust-on-first-use treatment every other
-- app has.
--
-- REDIRECT URI is the single absolute published URL. The web UI is a
-- single-page app on browser history, so it returns to one FIXED route rather
-- than to its own directory the way the server-docs console does — the directory
-- of `/settings/tunnel` is not the directory of `/home`, and only one of them
-- could ever be the registered value. `/home` is that route, derived per-origin
-- by `redirectUriForRoute` in `gatekeeper-core/smart-client`. Every other origin
-- the build runs at (a dev server, a PR preview) presents an unregistered
-- redirect and is carried to the consent prompt as a warning, exactly as the
-- server-docs console is away from its published address.
--
-- NOTE: the web build is not yet a section of the assembled GitHub Pages site
-- (`apps/github-pages/src/assembly.ts`), so `/app/` is the intended publish
-- location rather than a live one, and nothing serves this URL today. It is also
-- ahead of the app: the router is built with a plain `createBrowserHistory()` and
-- its routes are root-absolute, so `/app/home` needs a router basepath (and a
-- matching derivation in the app's `sign-in.ts`) before a copy served under
-- `/app/` would present this exact string. Until then such a copy presents
-- `<origin>/home`, which is simply an unregistered redirect: trusted on first use
-- through the consent prompt's warning, which is the same treatment every other
-- origin the build runs at already gets.
--
-- The owner UI drives every documented slice surface, so it may ask for anything
-- the server exposes — hence the MAXIMAL known scope set below, identical to the
-- server-docs console's and justified the same way: `allowed_scopes` is only the
-- ceiling on what may be *requested*, the authorize consent step is the narrowing
-- point, and `grantable_scopes` (scopes-rust) clamps an approval to the
-- intersection of requested ∧ allowed. The three wildcards cannot be collapsed
-- further — `wildflower/launch` is a *known* scope no wildcard covers, and the
-- FHIR and Wildflower resource grammars are disjoint. See 0007's header for the
-- per-entry derivation from `slices/scopes/scopes-rust`.
--
-- `allowed_grant_types` is `authorization_code` + `refresh_token`: the page runs
-- the PKCE code flow and may request `offline_access`. No device-code flow — the
-- landing page signs in by redirect now, and a page the user is already
-- looking at has no second-screen pairing story.
INSERT OR IGNORE INTO clients
    (client_id, name, kind, redirect_uris, allowed_scopes, allowed_grant_types, secret_hash, registered_at, disabled_at)
VALUES
    (
        'wildflower-react',
        'Wildflower Owner Console',
        'public',
        '["https://wildflowerhealth.io/app/home"]',
        '["openid","profile","fhirUser","launch","launch/patient","offline_access","wildflower/launch","system/*.cruds","wildflower/*.cruds"]',
        '["authorization_code","refresh_token"]',
        NULL,
        '2024-01-01 00:00:00+00:00',
        NULL
    );
