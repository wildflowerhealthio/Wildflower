# AGENTS.md — slices/servers

The **servers** this install knows about. Rust-only, no `-core`.

## Package roles

- **`servers-rust`** — `ServerRecord`, one server as the install stores it,
  and the `ServerRegistry` port over the list of them, with its
  `JsonServerRegistry` adapter at `<data root>/servers.json`; and enrolment,
  which checks a tunnel's credentials with its Wildflower relay through the
  `RelayClient` port, with its `ReqwestRelayClient` adapter.
  - Layout: `domain/` the record (`ServerRecord`, `RelayKind`, `TunnelToken`),
    `RegistryError`, and enrolment (`add_server`, `set_server_credentials`,
    `EnteredRelay`, `RelayPin`, `EnrolmentError`); `ports/` the
    `ServerRegistry` port (read all, insert, update, remove) and the
    `RelayClient` port (`GET /rathole`, signed `GET /me`); `adapters/`
    `JsonServerRegistry`, `ReqwestRelayClient` and the request signer it uses.
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
- **A relay is an official Wildflower relay, a self-hosted Wildflower relay
  or a rathole server.** `RelayKind::WildflowerOfficial` is the relay
  Wildflower runs at `RelayKind::WILDFLOWER_BASE_URL`,
  `https://relay.wildflowerhealth.io`; `RelayKind::SelfHostedWildflower` one
  someone else runs, with its Wildflower relay site at its `base_url`, whose
  host needn't match the domain its `GET /rathole` serves;
  `RelayKind::Rathole` a rathole server with no Wildflower relay site,
  whose settings were entered by hand. `RelayKind::site_base_url()` is `None`
  only for a rathole relay.
- **`public_settings` is the only copy of the relay's dial settings.** The
  rathole client always dials the `remote_addr` and `public_key` the relay's
  `GET /rathole` returned, or that were entered for a rathole relay.
  `RelayKind::SelfHostedWildflower` holds only the relay's `base_url`, and `RelayKind::Rathole`
  nothing.
- **A new server launches from `ServerRecord::DEFAULT_LAUNCHER_URL`**,
  `https://wildflowerhealth.io/app`.
- **The token is a secret.** `TunnelToken`'s `Debug` and `Serialize` write
  `<redacted>`, and it has no `Deserialize`. `JsonServerRegistry`'s own file
  representation is the only place the token is written in full, and the file
  is created readable by its owner only.
- **A Wildflower relay accepts a server before it is written.** For an
  `EnteredRelay::WildflowerOfficial` or `EnteredRelay::SelfHostedWildflower`, `add_server` builds a
  `RelayClient` for the relay's base URL, fetches its `GET /rathole`, checks
  its relay settings, compares them with the user's `RelayPin` when there is
  one, then confirms the tunnel name and token with a signed `GET /me`. The
  record gets that response as `public_settings`, the default launcher and
  production certificates. `set_server_credentials` replaces a server's token
  the same way, taking the relay's current `GET /rathole`, and refuses a
  relay that now serves another domain. A `401` from `GET /me` is
  `EnrolmentError::CredentialsRejected`.
- **A rathole relay is checked by its settings alone.** An
  `EnteredRelay::Rathole` carries `remoteAddr`, `publicKey` and `domain`; they
  become `public_settings` with the one transport and noise pattern a device
  runs, and no request is made: the tunnel coming up is the check.
  `set_server_credentials` replaces a rathole server's token without a
  request.
- **Relay settings get one check, served or entered.** The `domain` is a
  lowercase DNS name, the `remoteAddr` a `host:port`, and the `publicKey` 32
  bytes of base64. A `GET /rathole` that fails it is
  `EnrolmentError::BadRelayResponse`; an entered setting that fails it is
  `EnrolmentError::InvalidRelaySetting`, naming the setting.
- **Enrolment builds the relay client it asks.** `add_server` and
  `set_server_credentials` take a builder from the relay's base URL to a
  `RelayClient`, called only for a Wildflower relay; the commands pass
  `ReqwestRelayClient::new`, and tests a fake.
- **The pin is checked, never stored.** A `RelayPin` (the remote address and
  noise key entered by hand) only has to match the relay's `GET /rathole`;
  a mismatch is `EnrolmentError::PinMismatch`.
- **The token is never sent.** `GET /me` is signed with HTTP Message
  Signatures (RFC 9421), `alg="hmac-sha256"`, keyed by the token with the
  tunnel name as `keyid`, which the relay verifies with its own copy. The
  adapter's tests run against the relay's real site and verifier.
- **Everything on the wire and on disk is camelCase.** `server_add` takes
  `{relay, tunnelName, token}`, the relay one of `{kind: "wildflowerOfficial"}`,
  `{kind: "selfHostedWildflower", baseUrl, pin?}` with `pin` `{remoteAddr, publicKey}`, or
  `{kind: "rathole", remoteAddr, publicKey, domain}`; `server_set_credentials`
  takes `{domain, token}`. An `EnrolmentError`'s `kind` is camelCase
  (`credentialsRejected`, `alreadyRegistered`, ...), and so is every field of
  `servers.json`. Only the relay's own `GET /rathole` and `GET /me` keep its
  snake_case wire shape.
- **The commands trim the token.** Its surrounding whitespace is dropped, as
  the relay drops it from its own copy, and a token left empty is
  `EnrolmentError::EmptyToken`.
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
