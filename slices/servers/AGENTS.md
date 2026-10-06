# AGENTS.md — slices/servers

The **servers** this install knows about, and the **base**: the UI the Tauri
host's webview mounts to manage them.

## Package roles

- **`servers-rust`** — `ServerRecord`, one server as the install stores it,
  and the `ServerRegistry` port over the list of them, with its
  `JsonServerRegistry` adapter at `<data root>/servers.json`; and enrolment,
  which checks a tunnel's credentials with its Wildflower relay through the
  `RelayClient` port, with its `ReqwestRelayClient` adapter.
  - Layout: `domain/` the record (`ServerRecord`, `RelayKind`, `TunnelToken`),
    `RegistryError`, and enrolment (`add_server`, `set_server_credentials`,
    `EnteredRelay`, `RelayIdentity`, `EnrolmentError`); `ports/` the
    `ServerRegistry` port (read all, insert, update, remove) and the
    `RelayClient` port (`GET /rathole`, signed `GET /me`); `adapters/`
    `JsonServerRegistry`, `ReqwestRelayClient` and the request signer it uses.
- **`servers-tauri-rust`** — the base's Tauri commands over `servers-rust`:
  `server_add` and `server_set_credentials`, and `manage_servers`, which puts
  their `ServersState` in the app's managed state. Only glue; every decision
  and its tests are in `servers-rust`.
- **`servers-core`** — the host commands the base calls, as Effects over the
  `TauriInvoke` port (`invokeHostCommand`), each answer decoded by an Effect
  Schema: the app's version and the notification permission. No DOM, no
  React, no `@tauri-apps/api`.
- **`servers-react`** — `BaseRoot`, which `apps/wildflower-tauri/src/main.tsx`
  mounts with `@tauri-apps/api/core`'s `invoke`: the base's telemetry consent
  gate, then its router over `routes/`, `/` the server list and `/settings`
  the app's Settings (Notifications, Telemetry, About).

## Rules

- **A server's domain is its identity.** `ServerRecord::domain()` is
  `<tunnel name>.<relay domain>`, the relay domain being the `domain` its
  `GET /rathole` returned. There's no separate display name; the registry is
  keyed by the domain, and each server runs from its own folder,
  `<data root>/servers/<domain>/` (`ServerRecord::server_dir`), which holds
  its databases.
- **The tunnel name is one DNS label.** `ServerRecord::tunnel_name` is a
  `TunnelName` from `rathole-settings-rust`, the same check the relay applies
  to its tunnels: one lowercase DNS label, never `admin`. It is checked on
  construction and again when `servers.json` is read.
- **The relay domain is a DNS name.** It ends the server's domain and folder
  name, so wherever `servers-rust` takes one in (a `GET /rathole`, a rathole
  relay's entry, `servers.json`) it is decoded as a `RelayDomain` from
  `rathole-settings-rust`: lowercase DNS labels, nothing a path could escape
  through. A `servers.json` holding any other domain is refused, as one with
  a bad tunnel name is.
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
  `EnteredRelay::WildflowerOfficial` or `EnteredRelay::SelfHostedWildflower`,
  `add_server` builds a `RelayClient` for the relay's base URL, fetches its
  `GET /rathole`, checks its relay settings, compares them with the user's
  pin when there is one, then confirms the tunnel name and token with a
  signed `GET /me`. The record gets that response as `public_settings`, the
  default launcher and production certificates.
- **A relay's identity is pinned when the server is added.** Its
  `RelayIdentity`, the `remoteAddr` its rathole client dials and its noise
  `publicKey`, is kept in the record's `public_settings`. When
  `set_server_credentials` re-enters a Wildflower relay's token, the relay's
  current `GET /rathole` must present the same identity and domain before the
  signed `GET /me` is sent. Another domain is `EnrolmentError::DomainChanged`;
  another address or key is `EnrolmentError::RelayIdentityChanged` (kind
  `relayIdentityChanged`), whose message warns, as SSH does when a host's
  identification changes, that the relay may have been re-keyed or may be
  impersonated. Nothing is written either way, and the UI shows it as a
  warning rather than as a retry.
- **A rejected signature names no cause.** The relay answers a bare `401` to
  every signed request it refuses: an unknown tunnel name, the wrong token, a
  device clock more than a minute off, a replayed or malformed signature. So
  a `401` from `GET /me` is `EnrolmentError::SignedRequestRejected` (kind
  `signedRequestRejected`), whose message asks the user to check the tunnel
  name and token and the device's clock.
- **A rathole relay is checked by its settings alone.** An
  `EnteredRelay::Rathole` carries a `RelayIdentity` and a `domain`; they
  become `public_settings` with the one transport and noise pattern a device
  runs, and no request is made: the tunnel coming up is the check.
  `set_server_credentials` replaces a rathole server's token without a
  request.
- **Relay settings get one check, served or entered.** The `domain` is a
  `RelayDomain`, the `remoteAddr` a `host:port` as `parse_public_addr` from
  `rathole-settings-rust` reads one (a DNS name or bracketed IPv6 host, a
  port 1–65535, case-folded), the check the relay applies to its own public
  control address, and the `publicKey` 32 bytes of base64. A `GET /rathole`
  that fails it is `EnrolmentError::BadRelayResponse`; an entered setting
  that fails it is `EnrolmentError::InvalidRelaySetting`, naming the setting.
- **A self-hosted relay's `baseUrl` is checked when entered.** It must be an
  `https` URL with a host and no credentials, query or fragment, or it is
  `EnrolmentError::InvalidRelaySetting` for `baseUrl`. It is a directory: a
  relay site under a path prefix, `https://example.com/relay`, is asked for
  `https://example.com/relay/rathole` and `.../relay/me`.
- **Enrolment builds the relay client it asks.** `add_server` and
  `set_server_credentials` take a builder from the relay's base URL to a
  `RelayClient`, called only for a Wildflower relay; the commands pass
  `ReqwestRelayClient::new`, and tests a fake.
- **The pin is checked, never stored.** A self-hosted relay's `pin`, a
  `RelayIdentity` entered by hand, only has to match the relay's
  `GET /rathole`; a mismatch is `EnrolmentError::PinMismatch`. Once the
  server is added, the identity it was added with is the pin.
- **The token is never sent.** `GET /me` is signed with HTTP Message
  Signatures (RFC 9421), `alg="hmac-sha256"`, keyed by the token with the
  tunnel name as `keyid`, which the relay verifies with its own copy. The
  adapter's tests run against the relay's real site and verifier.
- **Everything on the wire and on disk is camelCase.** The commands take
  top-level parameters, which Tauri reads from the invoke payload under their
  camelCase names: `invoke('server_add', { relay, tunnelName, token })`, the
  relay one of `{kind: "wildflowerOfficial"}`,
  `{kind: "selfHostedWildflower", baseUrl, pin?}` with `pin`
  `{remoteAddr, publicKey}`, or `{kind: "rathole", remoteAddr, publicKey,
domain}`; and `invoke('server_set_credentials', { domain, token })`. An
  `EnrolmentError`'s `kind` is camelCase (`signedRequestRejected`,
  `relayIdentityChanged`, `alreadyRegistered`, ...), and so is every field of
  `servers.json`. Only the relay's own `GET /rathole` and `GET /me` keep its
  snake_case wire shape.
- **The commands trim the token.** Its surrounding whitespace is dropped, as
  the relay drops it from its own copy, and a token left empty is
  `EnrolmentError::EmptyToken`.
- **Commands answer without the token.** `server_add` answers with the
  server's domain and `server_set_credentials` with nothing; a failure the
  command reaches is the `EnrolmentError` as `{"kind", "message"}`, and their
  logs name the domain, never a parameter.
- **Only a malformed payload gets a plain string.** Every value a user types
  (tunnel name, token, base URL, rathole settings) is taken as a string and
  checked by the command, so a bad one is an `EnrolmentError`. A payload Tauri
  can't decode into the parameters at all (a missing key, a value of the
  wrong JSON type, an unknown relay `kind` or field) never reaches the
  command: Tauri rejects it with the string
  ``invalid args `<parameter>` for command `<command>`: <reason>``. The app grants both to the `main` webview
  only, through its `allow-server-enrolment` permission.
- **Configuration only.** `ServerRecord::running` is whether the user wants
  the server run, which the host reads at startup to choose what to start.
  Whether a run is up, its tunnel's liveness and its certificate are live
  state, held by whatever runs the server, never in a `ServerRecord`.
- **The first server added is set running.** `add_server` sets `running` when
  no registered server has it, and on no later server; nothing else changes
  it yet.
- **`servers.json` is versioned.** The file is
  `{"version": 1, "servers": [...]}`, its server fields `serde(remote)`
  mirrors of `ServerRecord` and `PublicRatholeSettings` renamed to camelCase,
  which the compiler keeps in step with those types. A version this build doesn't read is
  `RegistryError::UnsupportedVersion`, and the file is neither read nor
  overwritten. A change to the stored shape bumps the version.
- **Writes are atomic.** Every change writes the whole document to
  `.servers.json.tmp` beside the file, fsyncs it, renames it over
  `servers.json` and fsyncs the directory, so a crash leaves either the old
  file or the new one.
- **The base reaches the host only through Tauri commands.** Every call goes
  through `servers-core`'s `invokeHostCommand`, which decodes the answer with
  the command's schema, so nothing the host sends is trusted by its static
  type. The base mounts no effect-messaging transport. A command the base
  calls is granted to the `main` webview in
  `apps/wildflower-tauri/src-tauri/capabilities/default.json`.
- **The base asks for its own telemetry consent.** `BaseRoot` is a
  `TelemetryConsentGate` with `WILDFLOWER_HOST_TELEMETRY_CONSENT_COPY`; until
  it is answered no router or query cache exists and no host command is
  called. The answer starts telemetry with the DSN the app passes, from
  `VITE_SENTRY_DSN_WILDFLOWER_TAURI`, tagged `app: wildflower-tauri`. The web
  app's consent is its own, on its own origin.
- **`servers-rust` has no `tauri` dependency**, so it builds and tests in the
  non-Tauri partition of `scripts/checks/rust.sh`. `servers-tauri-rust` is in
  the Tauri partition.

## References

- [slices/AGENTS.md](../AGENTS.md) — slice layering rules this slice follows.
- `slices/tunnel/rathole-settings-rust` — `PublicRatholeSettings`, the
  `GET /rathole` response a record keeps as `public_settings`,
  `TunnelHost`, the `GET /me` response, and `TunnelName`.
- `apps/relay/server` — the relay whose `GET /rathole` and `GET /me`
  enrolment calls; its crate docs give the signing rules.
