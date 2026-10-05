# AGENTS.md — slices/servers

The **servers** this install knows about. Rust-only, no `-core`.

## Package roles

- **`servers-rust`** — `ServerRecord`, one server as the install stores it,
  and the `ServerRegistry` port over the list of them, with its
  `JsonServerRegistry` adapter at `<data root>/servers.json`; and enrolment,
  which checks a tunnel's credentials with its relay's site through the
  `RelaySite` port, with its `ReqwestRelaySite` adapter.
  - Layout: `domain/` the record (`ServerRecord`, `Relay`, `TunnelToken`),
    `RegistryError`, and enrolment (`add_server`, `set_server_credentials`,
    `RelayPin`, `EnrolmentError`); `ports/` the `ServerRegistry` port (read
    all, insert, update, remove) and the `RelaySite` port (`GET /rathole`,
    signed `GET /me`); `adapters/` `JsonServerRegistry`, `ReqwestRelaySite`
    and the request signer it uses.
- **`servers-tauri-rust`** — the base's Tauri commands over `servers-rust`:
  `server_add` and `server_set_credentials`, and `manage_servers`, which puts
  their `ServersState` in the app's managed state. Only glue; every decision
  and its tests are in `servers-rust`.

## Rules

- **A server's domain is its identity.** `ServerRecord::domain()` is
  `<tunnel name>.<relay domain>`, the relay domain being the `domain` its
  `GET /rathole` returned. There's no separate display name; the registry is
  keyed by the domain, and each server's data folder is
  `<data root>/servers/<domain>/`.
- **The tunnel name is one DNS label.** `ServerRecord::tunnel_name` is a
  `TunnelName` from `rathole-settings-rust`, the same check the relay applies
  to its tunnels: one lowercase DNS label, never `admin`. It is checked on
  construction and again when `servers.json` is read.
- **`public_settings` is the only copy of the relay's dial settings.** The
  rathole client always dials the `remote_addr` and `public_key` the relay's
  `GET /rathole` returned. `Relay::Custom` holds only the relay's `base_url`.
- **A new server launches from `ServerRecord::DEFAULT_LAUNCHER_URL`**,
  `https://wildflowerhealth.io/app`.
- **The token is a secret.** `TunnelToken`'s `Debug` and `Serialize` write
  `<redacted>`, and it has no `Deserialize`. `JsonServerRegistry`'s own file
  representation is the only place the token is written in full, and the file
  is created readable by its owner only.
- **A server is written only once its relay accepts it.** `add_server`
  fetches `GET {relay base}/rathole` (the Wildflower relay's base is
  `https://relay.wildflowerhealth.io`, a custom relay's its `base_url`),
  checks its `domain` is a lowercase DNS name and its `remote_addr` a
  `host:port`, compares it with the user's `RelayPin` when there is one, then
  confirms the tunnel name and token with a signed `GET /me`. The record gets
  that response as `public_settings`, the default launcher and production
  certificates. `set_server_credentials` replaces a server's token the same
  way, taking the relay's current `GET /rathole`, and refuses a relay that now
  serves another domain. A `401` from `GET /me` is
  `EnrolmentError::CredentialsRejected`.
- **The pin is checked, never stored.** A `RelayPin` (the remote address and
  noise key entered by hand) only has to match the relay's `GET /rathole`;
  a mismatch is `EnrolmentError::PinMismatch`.
- **The token is never sent.** `GET /me` is signed with HTTP Message
  Signatures (RFC 9421), `alg="hmac-sha256"`, keyed by the token with the
  tunnel name as `keyid`, which the relay verifies with its own copy. The
  adapter's tests run against the relay's real site and verifier.
- **Commands answer without the token.** `server_add` answers with the
  server's domain and `server_set_credentials` with nothing; a failure is the
  `EnrolmentError` as `{"kind", "message"}`. Their arguments have no `Debug`,
  and their logs name the domain. The app grants both to the `main` webview
  only, through its `allow-server-enrolment` permission.
- **Configuration only.** Whether a server is running, its tunnel's liveness
  and its certificate are live state, held by whatever runs the server, never
  in a `ServerRecord`.
- **`servers.json` is versioned.** The file is
  `{"version": 1, "servers": [...]}`. A version this build doesn't read is
  `RegistryError::UnsupportedVersion`, and the file is neither read nor
  overwritten. A change to the stored shape bumps the version.
- **Writes are atomic.** Every change writes the whole document to
  `.servers.json.tmp` beside the file, fsyncs it, renames it over
  `servers.json` and fsyncs the directory, so a crash leaves either the old
  file or the new one.
- **`servers-rust` has no `tauri` dependency**, so it builds and tests in the
  non-Tauri partition of `scripts/checks/rust.sh`. `servers-tauri-rust` is in
  the Tauri partition.

## References

- [slices/AGENTS.md](../AGENTS.md) — slice layering rules this slice follows.
- `slices/tunnel/rathole-settings-rust` — `PublicRatholeSettings`, the
  `GET /rathole` response a record keeps as `public_settings`,
  `TunnelHost`, the `GET /me` response, and `TunnelName`.
- `apps/wildflower-relay` — the relay whose `GET /rathole` and `GET /me`
  enrolment calls; its crate docs give the signing rules.
