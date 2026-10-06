# AGENTS.md — slices/servers

The **servers** this install knows about, and the **base**: the UI the Tauri
host's webview mounts to manage them.

## Package roles

- **`servers-rust`** — `ServerRecord`, one server as the install stores it,
  its `RunPolicy`, and the `ServerRegistry` port over the list of them, with
  its `JsonServerRegistry` adapter at `<data root>/servers.json`; enrolment,
  which checks a tunnel's credentials with its Wildflower relay through the
  `RelayClient` port, with its `ReqwestRelayClient` adapter; and the changes to
  a registered server, with `servers_to_run`, which servers should be running.
  - Layout: `domain/` the record (`ServerRecord`, `RelayKind`, `TunnelToken`,
    `RunPolicy`), `RegistryError`, enrolment (`add_server`,
    `set_server_credentials`, `EnteredRelay`, `RelayIdentity`,
    `EnrolmentError`), and the server changes (`set_run_policy` from a
    `RunPolicyChoice`, `update_server`, `remove_server`, `servers_to_run`,
    `ServerChangeError`); `ports/` the `ServerRegistry` port (read all,
    insert, modify, remove) and the `RelayClient` port (`GET /rathole`, signed
    `GET /me`); `adapters/` `JsonServerRegistry`, `ReqwestRelayClient` and the
    request signer it uses.
- **`servers-tauri-rust`** — the host side of the base: its Tauri commands
  over `servers-rust` (`servers_list`, `server_add`, `server_set_credentials`,
  `server_set_run_policy`, `server_update`, `server_remove`); the reconciler,
  which starts and stops servers to match their run policies through the
  `ServerService` port the app implements; and `ServerStatuses`, each server's
  `ServerStatus`, emitted as the `server-status` event. `manage_servers` puts
  their `ServersState` in the app's managed state, and `reconcile_servers`
  runs the reconciler's first pass. Decisions about a record are in
  `servers-rust`.
  - Layout: `commands.rs` the commands and `ListedServer`; `reconciler.rs`;
    `server_service.rs` the `ServerService` port; `server_status.rs`
    `ServerStatus` and `ServerStatuses`.
- **`servers-core`** — the host commands the base calls, as Effects over the
  `TauriInvoke` port (`invokeHostCommand`), each answer decoded by an Effect
  Schema: the app's version, the notification permission, and the server
  commands (`listServers`, `setServerRunPolicy`, `updateServer`,
  `removeServer`), with `decodeServerStatus` for the `server-status` event's
  payload. A host refusal decodes as a `HostRefusal`, `{kind, message}`. No
  DOM, no React, no `@tauri-apps/api`.
- **`servers-react`** — `BaseRoot`, which `apps/wildflower-tauri/src/main.tsx`
  mounts with `@tauri-apps/api/core`'s `invoke`: the base's telemetry consent
  gate, then its router over `routes/`, `/` the server list (each server's
  domain, or the host's error when it can't read `servers.json`) and
  `/settings` Host Settings, for the app on this device rather than any one
  server (Notifications, Telemetry, About).

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
domain}`; `invoke('server_set_credentials', { domain, token })`;
  `invoke('servers_list')`; `invoke('server_set_run_policy', { domain,
policy })`, the policy one of `{kind: "off"}`, `{kind: "whileInUse"}`,
  `{kind: "for", seconds}` or `{kind: "always"}`;
  `invoke('server_update', { domain, launcherUrl, stagingCertificates })`; and
  `invoke('server_remove', { domain })`. An error's `kind` is camelCase
  (`signedRequestRejected`, `relayIdentityChanged`, `alreadyRegistered`,
  `nonPositiveDuration`, ...), and so is every field of `servers.json` and of
  the `server-status` event. Only the relay's own `GET /rathole` and `GET /me` keep its
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
  ``invalid args `<parameter>` for command `<command>`: <reason>``. The same
  holds for the other commands: a launcher URL is taken as a string and
  checked, so a bad one is a `ServerChangeError`, and an unknown policy
  `kind` is Tauri's plain string.
- **Every command grant is the `main` webview's only.** The app grants the
  enrolment commands through its `allow-server-enrolment` permission, and
  `servers_list`, `server_set_run_policy`, `server_update` and
  `server_remove` through its `allow-server-management` permission, both in
  `capabilities/default.json`.
- **Configuration only.** `ServerRecord::run_policy` is when the user wants
  the server run. Whether a run is up, its tunnel's liveness, when it started
  and its certificate are live state, held by the host in each server's
  `ServerStatus`, never in a `ServerRecord`.
- **A run policy is `off`, `whileInUse`, `until` or `always`.** A policy is
  active (`RunPolicy::is_active_at`) when it is `always`, `whileInUse`, or an
  `until` whose `at` is still ahead. The host has no in-use tracking yet, so
  `whileInUse` runs while the app's process is alive. The user picks a
  `RunPolicyChoice`, which gives the window as `{kind: "for", seconds}`; it is
  stored as `{kind: "until", at: now + seconds}`, and zero seconds or less is
  `ServerChangeError::NonPositiveDuration`.
- **An expired `until` stays as it is.** Nothing rewrites a policy when its
  deadline passes: it stays in `servers.json`, counts as inactive, and the
  server isn't started. Only the user's commands write a policy.
- **A new server runs if nothing else does.** `add_server` gives it
  `whileInUse` when no registered server's policy is active, and `off`
  otherwise.
- **One server runs at a time.** Setting a policy other than `off` on one
  server sets every other server `off` in the same registry change, and
  `servers_to_run` returns at most `MAX_RUNNING_SERVERS` (one) of the servers
  whose policy is active. The command and event shapes are keyed by domain,
  so running several only changes the cap and the app's `ServerService`.
- **Registry changes are read-modify-write.** `ServerRegistry::modify` reads
  the servers, applies a change and writes them as one change. A change edits
  only the fields it is about on the record as it is then: re-entering
  credentials writes only the token and `public_settings` once the relay has
  answered, so a run policy set during the relay's round trip is kept.
- **The reconciler starts and stops servers.** `ServersState::reconcile`
  reads the registry, takes `servers_to_run` now, stops each server it started
  that is no longer among them and starts each one it hasn't. It runs once at
  setup (`reconcile_servers`) and after every command, and is what whatever
  watches the policies' conditions calls. A server it started stays started
  until it leaves that set. One that failed to start isn't tried again on
  every pass, only once `server_set_run_policy` sets its policy again or it
  leaves the set and comes back.
  A registry it can't read stops nothing; with nothing started it tells the
  service why, and so does a pass that starts nothing, so a run the platform
  or the OS starts on its own ends with that reason logged.
- **Every server has a status, and every failure shows in one.**
  `ServerStatus` is the server's `ServerRunState` (`starting`, `running`, or
  `stopped` with its error), its `TunnelLiveness`, and `startedAt`, set when a
  run reaches `running` and cleared when it stops. A server whose start fails
  (its config can't be built, the service won't start) is `stopped` with the
  error. Each change is emitted as the `server-status` event, and
  `servers_list` answers with each server's current one. A `servers.json` that
  can't be read is `servers_list`'s error, which the base shows.
- **Removing a server stops it first.** `server_remove` stops the server
  through the service, with the reconciler held so nothing starts it again,
  then deletes its folder, which holds its databases and certificates, then
  its record. A server that can't be stopped, or whose folder can't be
  deleted, stays registered.
- **The wire is pinned.** `slices/servers/servers-wire-golden.json` holds the
  listed servers, run policies, run-policy choices and a command error as the
  host sends and takes them; `servers-tauri-rust`'s tests serialise to it and
  `servers-core`'s decoders read it, so neither side changes a field alone.
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
- `slices/shared-structures/shared-structures-rust` — `ServerRunState` and
  `TunnelLiveness`, the run's state and its tunnel's liveness a
  `ServerStatus` carries.
- [background-server-service AGENTS.md](../background-server-service/AGENTS.md)
  — the service the app's `ServerService` runs a server through.
