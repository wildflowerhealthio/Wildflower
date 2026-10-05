# AGENTS.md — slices/relay

The TypeScript side of the tunnel relay: its admin API as an `HttpApi`, the
signer every admin call goes through, the key it signs with, and the admin
screen. The relay itself is the Rust binary in
[`apps/relay/server`](../../apps/relay/server) (`wildflower-relay`), and the
page it serves at `https://admin.<domain>/` is
[`apps/relay/web`](../../apps/relay/web/AGENTS.md).

## Packages

- `relay-core` — no React. Four entries:
  - `relay-core/http-api-definition`: `RelayAdminApi`, the admin API as the
    relay serves it (`apps/relay/server/src/site/admin.rs`): `CreateTunnel`,
    `ListTunnels` and `DeleteTunnel`, with the relay's snake_case JSON field
    names. `created_at` decodes from unix seconds to a `DateTime.Utc`. The
    relay's refusals are plain text, decoded into tagged errors carrying it as
    `reason` (`TunnelNameConflict` `409`, `TunnelRejected` `422`,
    `TunnelNotFound` `404`, `TunnelNamesExhausted` `503`); its `401` is
    empty, and decodes as `HttpApiError.Unauthorized`.
  - `relay-core/clients`: `RelayAdminHttpApiClient`, from
    `defineSliceHttpClient`.
  - `relay-core/signing`: `signAdminRequest`, which signs a request as the
    relay's verifier (`site/signature.rs`) expects, and `signingHttpClient`,
    an `HttpClient` layer that signs every request with the stored key and
    sends it to the absolute URL it signed.
  - `relay-core/key-store`: `importAdminKey`, which turns the pasted
    `WILDFLOWER_RELAY_ADMIN_KEY` into a non-extractable HMAC SHA-256
    `CryptoKey`, and `AdminKeyStore`, where that key lives: IndexedDB in the
    browser (`layerIndexedDb`), memory in tests (`layerMemory`).
- `relay-react` — the admin screen (`RelayAdminScreen`) under a
  `RelayAdminProvider`, and the TanStack Query hooks it is built from. CSS
  modules use BEM, the block named after the component's file.

## Rules

- **The signature is a contract with the Rust verifier, and a fixture holds
  both sides to it.** `src/signing/fixtures/admin-request.json` is a request
  `signAdminRequest` signed. relay-core's test checks the signer still
  produces it, and `apps/relay/server`'s
  `admin_request_fixture_from_the_js_signer_verifies` checks the relay
  accepts it. A change to the signer regenerates it with
  `UPDATE_FIXTURES=1 vp test` (in `relay-core`); if the relay then rejects
  it, the signer is wrong.
- **What is signed:** one signature labelled `sig`, covering `@method`,
  `@target-uri` and, with a body, `content-digest` (`sha-256`), with
  `created`, `nonce` (16 random bytes, base64url), `keyid="admin"` and
  `alg="hmac-sha256"`. `@target-uri` is the absolute URL of the request,
  against the page's own origin. `http-message-signatures` derives the
  components and formats the signature base, from its `lib/httpbis` entry:
  the package root also loads a module that `require`s Node's `crypto`. Its
  `signMessage` is not used, because it passes the base to the key as a
  Node `Buffer`.
- **The key never leaves Web Crypto.** The pasted text is trimmed, checked
  for the relay's 32-byte minimum by `AdminKeyText`, imported raw (the relay
  keys its MAC with the text's UTF-8 bytes) as a non-extractable, sign-only
  key, and only that `CryptoKey` is stored. Nothing goes in cookies or
  `localStorage`.
- **A `401` signs the screen out.** `RelayAdminProvider` deletes the stored
  key on any `Unauthorized` and shows the key form again, saying the key is
  wrong or the device's clock is more than a minute off the relay's.

## References

- [Architecture / slice layering](../AGENTS.md)
- [apps/relay/web AGENTS.md](../../apps/relay/web/AGENTS.md) — the page
- `apps/relay/server/src/lib.rs` — the relay, its signed requests and admin
  API
- [Testing Reference](../../docs/Testing/Testing%20Reference.md) — the
  cross-language fixture pattern
