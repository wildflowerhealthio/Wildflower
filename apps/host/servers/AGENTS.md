# AGENTS.md — apps/host/servers

The **servers** this install knows about, how the Tauri host runs them, and
the **base**: the UI the Tauri host's webview mounts to manage them. Read the
[Server Runs Explanation](./docs/Server%20Runs%20Explanation.md) before
changing how servers run or what the host notifies about them.

## Package roles

- **`servers-rust`** — `ServerRecord`, one server as the install stores it,
  and the `ServerRegistry` port over the list of them, with its
  `JsonServerRegistry` adapter at `<data root>/servers.json`; and enrolment,
  which checks a tunnel's credentials with its Wildflower relay, first
  redeeming a claim code for them when one was entered, through the
  `RelayClient` port, with its `ReqwestRelayClient` adapter; and the changes
  to a registered server: its run policy, its launcher, Authorization app and
  certificate source, and its removal. `ServerUnit`, a server as a unit `UnitRunner` runs, with
  `ServerDetail`, what its runs report (the run, a `ServerRunId`, health,
  tunnel state, certificate state and the newest consent waiting), its
  `ServerLaunchMinter` included,
  through which the host mints a running server's launches, and its
  `ServerSignInCodeMinter`, through which it mints the codes that sign the
  browser in as the server's Owner; launching (`ensure_launchable`,
  `launch_url`, `authorization_app_url`, `sign_in_url`,
  `consent_sign_in_url`, `LaunchError`); `ServerStatus`, a server's status on
  `UnitRunner` as the base receives it, and `ListedServer`, with the
  certificate state its run reported or its cache holds; `PendingConsent`,
  the newest consent waiting on a server, named by its `ConsentKey`; and the
  notification decisions: the stop notification for each new stop of a server's run, and the consent
  notification for each new request waiting on a server; and `ConsentViews`, the consents showing in
  a view of the in-app browser, so each opens in one.
  - Layout: `domain/` the record (`ServerRecord`, `RelayKind`, `TunnelToken`),
    `RegistryError`, enrolment (`add_server`, `set_server_credentials`,
    `EnteredRelay`, `EnteredCredentials`, `RelayIdentity`, `EnrolmentError`),
    server changes
    (`set_run_policy` with `RunPolicyChoice`, `update_server` with
    `ServerUpdate`, `remove_server`, `ServerChangeError`), `ServerDetail`
    with `ServerRunId`,
    `ServerStatus` with `ServerStatusTracker`, `ListedServer`, the
    certificate state's wire shape (`certificate_state_wire`),
    `PendingConsent` with `ConsentKey`, launching (`ensure_launchable`,
    `launch_url`, `authorization_app_url`, `sign_in_url`,
    `consent_sign_in_url`, `LaunchError`), and `notifications/`
    (`LocalNotification` with its `fnv1a` id hash,
    `StopNotificationCoalescer` with
    `ServerStop` and `StopCause`, `ConsentNotificationCoalescer` with
    `ConsentRequest` and `server_of_consent_notification`, and `ConsentViews`
    with `ConsentViewClaim` and `IfShowing`); `ports/` the
    `ServerRegistry` port (read all, insert, modify, remove) and the
    `RelayClient` port (`GET /rathole`, signed `GET /me`, `POST /claim`);
    `adapters/`
    `JsonServerRegistry`, `ReqwestRelayClient` and the request signer it uses;
    `live_bindings/` `ServerUnit`, bound to `wildflower-server-rust`;
    `ServerLaunchMinter`, bound to `authorization-server-rust`'s
    `LaunchContextMinter`; `ServerSignInCodeMinter`, bound to its
    `SameDeviceSignInCodeMinter`; and `ServerConsentWatcher`, bound to its
    `PendingConsentWatcher`. `tests/server_unit.rs` runs the real
    server through `UnitRunner`, the consent waiting on it included.
- **`servers-tauri`** — the host side. `host_servers`, called from the
  app's `setup()`, pushes every server to the app's `TauriUnitRunner` through
  `ServerUnits::push`, emits the `server-status` event, posts the stop
  and consent notifications, opening each consent's request in the
  default browser on the desktop, sets the app icon's badge to how many
  servers have a consent request pending, as the consent notifications'
  coalescer counts them (`pending_consent_badge`), and manages the
  commands' `ServersState`. The base's Tauri commands: `servers_list`, `server_add`,
  `server_set_credentials`, `server_set_run_policy`, `server_update` and
  `server_remove`, each writing the registry and then pushing what it wrote;
  and `server_launch`, `server_open_authorization_app`,
  `server_open_pending_consent` and `server_open_notified_consent`, which open
  a server's launcher, its Authorization app and the consent waiting on it in
  the in-app browser, signed in as the Owner, behind the `LaunchBrowser` port,
  each view counting toward `WhileOpen` through the `LaunchPresence` port. Only glue; every decision and
  its tests are in `servers-rust`, except the commands' own order of write and
  push, tested here against a real `TauriUnitRunner`.
- **`servers-core-js`** — the host commands the base calls, as Effects over the
  `TauriInvoke` port (`invokeHostCommand`), each answer decoded by an Effect
  Schema: the server commands (`listServers`, `addServer`,
  `setServerCredentials`, `setServerRunPolicy`, `updateServer`,
  `removeServer`, `launchServer`, `openServerAuthorizationApp`,
  `openPendingConsent`, `openNotifiedConsent`), the background session's
  recovery (`enableBackgroundSessionRecovery`), and the app's version and the
  notification permission; and the wire's namespaces, `ListedServer`,
  `ServerStatus` (with the `server-status` event's name and decoder, and
  `pendingConsentOf`), `RunPolicy`, `RunPolicyChoice`, `PendingConsent`, the
  newest consent waiting on a server, `EnteredRelay` and
  `EnteredCredentials`, `server_add`'s relay and credentials, each a
  `Schema` and its `Type` with getters; and `LaunchError`'s
  `statusRefusalOf`, the refusal `server_launch` answers from a status, with
  `certificateRefusalOf`, its certificate's part, held to the host's by the
  golden file; and `HostPlatform`, the kind of device the host runs on
  (`ios`, `android` or `desktop`). A refused
  command is a `HostCommandFailed` whose `refusal` is the host's
  `{kind, message}`. Besides the host, `readServerHealth` reads a server's
  `/health` at its public origin, an Effect over `@effect/platform`'s
  `HttpClient` decoded as a `HealthReport`. No DOM, no React, no
  `@tauri-apps/api`.
- **`servers-react`** — the base, as pieces `apps/host/host-app` composes
  into its one router, as `launcher-web` composes the launcher's packages:
  `BaseGate`, the base's telemetry consent gate, then the background
  session's recovery and the opening of the consent a tapped consent
  notification announced, around the whole app, with `@tauri-apps/api/core`'s
  `invoke` and `addPluginListener`, and the background service's start config
  from `tauri-shared-config.json`; `ServersRouterContext`, the context the base's
  routes read, which `ServersRouterContext.make` builds, query cache included,
  from `invoke`, the device's `HostPlatform`, which the app maps once from
  the `TAURI_ENV_PLATFORM` the Tauri CLI builds it with (the base never
  detects it),
  `@tauri-apps/api/event`'s `listen` and the default launcher
  and Authorization app from `tauri-shared-config.json`; `BaseLayout`, the page shell;
  and the route bucket `routes/_servers/`, which the app mounts
  under a pathless `_servers` layout whose component is `BaseLayout`:
  `/` the server list, `/servers/new` Add server, `/servers/$domain` a
  server's page and `/settings` Host Settings, for the app on this device rather than any one
  server (Notifications, Telemetry, Legal — the privacy policy, consumer health data
  policy, terms of use and deletion page on the canonical site, opened in the system browser — and
  About). The server list is a card per
  server, kept current by the `server-status` event: its domain and a status
  dot merged from its run state, its tunnel's state and its health, a
  refused or reconnecting tunnel taking priority over a `reachable` health
  that predates it; a run-policy field
  (`RunPolicyPicker`) that says when it runs, outlined in the dot's tone, over
  a native picker that changes it at once, putting the previous policy back
  if the host refuses (the refusal shows under the field); a live `until`
  says the time left, rounded up (minutes under an hour, never "0 min", then
  whole hours), and its deadline ("On for 2 h — until …"), and an ended one
  "Ended at …", the field's clock ticking each minute (`useNow`, on the
  deadline's minutes, until it passes, and again as the page is shown, the
  clock `useHasPassed` shares) so it reads as ended once the deadline passes;
  on iOS and Android, while the policy is `always` or a live `until`, a note
  above the field, which describes its picker, says how long that phone lets
  the server run once Wildflower is left (Android: 2 minutes; iOS: about 25
  seconds, then only in short spells iOS allows); under it, what the
  status says beyond plain Running or Stopped, with the host's reason a
  running server isn't reachable, why its tunnel is reconnecting, or what to
  do about a relay that rejected its token or has no tunnel of its name; why its latest run stopped; Launch (`LaunchButton`);
  Authorization (`AuthorizationButton`), which opens the server's Wildflower
  Authorization app through `server_open_authorization_app`, disabled while
  the webview is offline or the host would refuse for what the status shows,
  never starting a server; and
  Edit, which opens the server's page, kept current by the `server-status`
  event too: its domain with Copy, its status badge, when its run started, the
  run-policy field, and Launch with Authorization under it, each full width;
  while a consent waits on the server, a Pending request row, "‹client› wants
  access.", with Open (`server_open_pending_consent`), the host's refusal
  taking the row's text; over three tabs in component state. Status holds the
  host's last check of its connection (said to be from before, once the
  tunnel has dropped or been refused since), with its tunnel's connection to
  the relay while a run reports it (a failure once the relay refused the
  tunnel), or how its latest run stopped, and
  while it runs its `/health` report with each check, read by the webview
  itself, with Refresh; its launcher and its Authorization app, each with
  Reset to default (`PageUrlForm`), named "Reset Launcher URL to default" and
  "Reset Authorization Manager URL to default" for assistive technology; and
  its removal, said in full, behind a confirm that asks for the domain to be
  typed. Relay holds its relay and tunnel name and a new tunnel token (`server_set_credentials`), in a
  password field that starts empty, a `relayIdentityChanged` refusal shown
  as a warning that the relay may be impersonated, with no retry.
  Certificate holds its certificate's state (its `certificate`): the status in words,
  shown as a failure only for `orderFailing` and `cacheUnreadable`, the
  certificate authority the server orders from (the record's, which Save
  Launcher URL and Save Authorization Manager URL save unchanged), and the one the state is for (its `issuer`) when
  that differs, the held certificate's validity and SHA-256 fingerprint, and
  the latest error, described by its kind, a rate limit's retry time saying
  so once it has passed (one timer, set for it). With no servers it says what
  a server is, beside Add new server; with servers, Add new server is under
  the cards, across the page. Add server goes a step at a time, in component state rather than
  the URL, so the token never reaches it: the relay, under what it can and
  can't see (the Wildflower official relay, a self-hosted Wildflower relay
  by URL with an Advanced pin, or a different reverse proxy, a rathole
  server by its address, key and tunnel domain); the tunnel: for a
  Wildflower relay a claim code, uppercased as typed, by default, or, through
  the link-styled "I have a tunnel name and full length token" above the
  buttons, the tunnel name and token, with "I have a claim code" back; for a
  rathole relay only the tunnel name, lowercased as typed as is a rathole
  tunnel domain, with the address it gives the server, and masked token;
  Checking, while `server_add`
  checks and registers, staying there on a refusal with the host's message,
  Back (every entry kept) and Retry; and the server added, its domain, a
  privacy note, and Start now or Start later (`whileOpen` or `off`), which
  opens its page. The claim code and the token are dropped from state once
  the host has added the server.
  Launch and Authorization report their failures, the host's refusal or why
  a wait gave up, through `onError`, and each start through `onActionStart`
  (`useActionError`): the card, and the page's status, shows
  the latest failure in one banner across it, above the buttons, until either
  starts again. Launch's reasons stay above its own button.
  Launch opens the server's launcher through `server_launch`, signed in as
  the Owner. It is
  disabled, saying why: while the webview is offline (`navigator.onLine`),
  that launching needs a connection (the host commands themselves need none,
  so the base's query client runs them offline too:
  `networkMode: 'always'`); for a running server the host would refuse (its
  relay rejected its tunnel token or has no tunnel of its name, not yet
  reached, unreachable, no valid certificate, a certificate browsers don't
  trust);
  and for a server that isn't running while its run policy still wants it
  running. For a server that isn't running whose policy is `off` or an
  ended `until`, it asks "Start server and launch?"; confirming sets
  `whileOpen`, then it shows "Starting…", with Cancel, over why the server
  can't be launched yet (starting, not yet reached, unreachable with the
  host's reason, no valid certificate, or how its run stopped during the
  wait: after the confirm, by the device's clock that stamps the host's
  stops too), until the server's status is launchable, and launches it
  once. The wait gives up, showing why, with Launch back, once waiting
  can't help: the server's run stopped with an error during the wait, its
  relay refused its tunnel, its certificate order is failing, its certificate is one browsers don't
  trust, or it has been unreachable while its certificate is valid for 5
  seconds without a break (any other status starts that again: the host
  probes only once the tunnel is connected, first after 400 ms and then
  after twice the last wait, so the grace spans the first few probes). The wait is held in the router
  context's `pendingLaunches`, a store keyed by domain, so it carries on
  when Edit opens the server's page, whose Launch shows the same wait.
  Launching never changes an active policy or extends an `until`.
  The base decides no consent itself: Open, and a tap on a consent
  notification on a phone, open the server's own consent page in a browser
  signed in as the Owner. The host app's shell opens a server's page when a
  consent comes to wait first on it.

## Rules

- **A server's domain is its identity.** `ServerRecord::domain()` is
  `<tunnel name>.<relay domain>`, the relay domain being the `domain` its
  `GET /rathole` returned. There's no separate display name; the registry is
  keyed by the domain, and each server runs from its own folder,
  `<data root>/servers/<domain>/` (`ServerRecord::server_dir`), which holds
  its databases and, in `certificates/`, its certificates and their keys.
- **New servers get production certificates.** A record's
  `certificate_authority`, a `CertificateAuthority` (`LetsEncryptStaging` or
  `LetsEncrypt`, from `wildflower-server-rust`, re-exported here), is the
  ACME CA its runs order from.
  `ServerRecord::DEFAULT_CERTIFICATE_AUTHORITY` is `LetsEncrypt`. All of a
  relay's servers share its registered domain, and with it Let's Encrypt's
  limit of 50 certificates per registered domain per week.
- **One ACME account per install.** Every server orders its certificates
  with the account whose key is in `<data root>/acme-account/`, one key per
  CA, created by the first order.
- **The record is the certificate's one source.**
  `ServerRecord::device_certificate_config` builds a run's
  `DeviceCertificateConfig`: its `certificate_authority` and that CA's
  directory (`CertificateAuthority::directory_url`), the server's
  `certificates/` folder and the install's `acme-account/` folder. The host passes it through to
  `wildflower-server-rust` unchanged.
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
- **A new server launches from the hosted launcher**, the release
  `launcher_base_url` in `apps/host/host-app/tauri-shared-config.json`, in
  every build: a debug build's own launcher links go to the dev server, but
  its new servers still launch from the published UI. The host reads it at
  compile time and `add_server` gives it to each server it adds
  (`ServersState`, from `host_servers`); the app hands the same value to
  `ServersRouterContext.make` (`defaultLauncherUrl`), so the server page offers Reset to
  default only while the saved launcher differs from it, compared as parsed
  URLs, and saves it through `server_update`.
- **A new server opens the hosted Authorization app**, the
  `authorization_app_base_url` in
  `apps/host/host-app/tauri-shared-config.json`, in every build. The host
  reads it at compile time and `add_server` gives it to each server it adds,
  and `JsonServerRegistry` to each server it reads from a version 1 or 2
  file; the app hands the same value to `ServersRouterContext.make`
  (`defaultAuthorizationUrl`) for the server page's Reset to default, as it
  does the launcher's.
- **The token is a secret.** `TunnelToken`'s `Debug` and `Serialize` write
  `<redacted>`, and it has no `Deserialize`. `JsonServerRegistry`'s own file
  representation is the only place the token is written in full, and the file
  is created readable by its owner only.
- **A Wildflower relay accepts a server before it is written.** For an
  `EnteredRelay::WildflowerOfficial` or `EnteredRelay::SelfHostedWildflower`,
  `add_server` builds a `RelayClient` for the relay's base URL, fetches its
  `GET /rathole`, checks its relay settings, compares them with the user's
  pin when there is one, then redeems a claim code for the tunnel name and
  token when one was entered, or confirms an entered tunnel name and token
  with a signed `GET /me`. The record gets the `GET /rathole` response as
  `public_settings`, the default launcher and the default certificate
  source.
- **A claim code is spent once, when the server is added.** An
  `EnteredCredentials::ClaimCode` is sent to the relay's `POST /claim` only
  after its `GET /rathole` has passed its checks and matched any pin, so a
  relay that isn't the one expected never gets it. The relay redeems it,
  once, for the `ClaimedTunnel` (`rathole-settings-rust`): the tunnel name
  and token, which the record holds as if they had been entered, and the
  relay settings, which must be the domain, address and key `GET /rathole`
  served, or it is `EnrolmentError::BadRelayResponse` for `/claim`. No
  signed `GET /me` follows: the code is spent once `POST /claim` answers, so
  a later failure, such as a skewed clock's rejected signature, would leave
  the user retrying a spent code (`ClaimCodeRejected`), and the claimed
  settings are already tied to the relay's `GET /rathole`. The code
  is stored nowhere, and `server_set_credentials` takes a token only. A `422`
  is `EnrolmentError::ClaimCodeRejected` (unknown, used or expired: the relay
  gives one answer for all), a `429` `ClaimRateLimited`, and a `404`, a relay
  site run without its admin API, `ClaimCodesNotOffered`, as is a claim code
  entered for a rathole relay, refused before anything is asked.
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
  camelCase names: `invoke('server_add', { relay, credentials })`, the
  relay one of `{kind: "wildflowerOfficial"}`,
  `{kind: "selfHostedWildflower", baseUrl, pin?}` with `pin`
  `{remoteAddr, publicKey}`, or `{kind: "rathole", remoteAddr, publicKey,
  domain}`, and the credentials `{kind: "claimCode", code}` or
  `{kind: "token", tunnelName, token}`; and
  `invoke('server_set_credentials', { domain, token })`. An
  `EnrolmentError`'s `kind` is camelCase (`signedRequestRejected`,
  `relayIdentityChanged`, `alreadyRegistered`, ...), and so is every field of
  `servers.json`. Only the relay's own `GET /rathole` and `GET /me` keep its
  snake_case wire shape, and so do `POST /claim`'s request and response.
- **Entered credentials are trimmed.** A token's surrounding whitespace is
  dropped (`TunnelToken::entered`), as the relay drops it from its own copy,
  and a token left empty is `EnrolmentError::EmptyToken`; a claim code is
  trimmed too, and one left empty is `EnrolmentError::EmptyClaimCode`.
  `add_server` checks the credentials, the tunnel name included, before any
  relay is asked.
- **Commands answer without the token.** `server_add` answers with the
  server's domain and `server_set_credentials` with nothing; a failure the
  command reaches is the `EnrolmentError` as `{"kind", "message"}`, and their
  logs name the domain, never a parameter. `EnteredCredentials`'s `Debug`
  prints neither the claim code nor the token. `servers_list` lists a server's
  domain, relay, tunnel name, launcher, Authorization app, certificate
  authority, run policy, status and certificate state, never its token or the relay's dial
  settings.
- **The change commands answer with `{kind, message}` too.**
  `server_set_run_policy` (`{domain, choice}`) answers with the run policy
  stored, `server_update` (`{domain, launcherUrl, authorizationUrl,
  certificateAuthority}`) and
  `server_remove` (`{domain}`) with nothing; a failure is the
  `ServerChangeError`. `servers_list` answers an unreadable `servers.json`
  with its `RegistryError`, kind `registry`, which the base shows.
- **Only a malformed payload gets a plain string.** Every value a user types
  (claim code, tunnel name, token, base URL, rathole settings) is taken as a
  string and
  checked by the command, so a bad one is an `EnrolmentError`. A payload Tauri
  can't decode into the parameters at all (a missing key, a value of the
  wrong JSON type, an unknown relay or credentials `kind` or field) never
  reaches the
  command: Tauri rejects it with the string
  ``invalid args `<parameter>` for command `<command>`: <reason>``. The app grants both to the `main` webview
  only, through its `allow-server-enrolment` permission.
- **A server is one unit, keyed by its domain.** `ServerUnits::push` is the
  one place a record becomes `set_unit(domain, run_policy, factory)`; the
  factory builds a fresh `ServerUnit` from that record for each run, through
  the host's server config builder. Don't start a server any other way.
- **Write, then push, under one lock.** A command that writes a server holds
  `ServersState::registry_writes` from before its write until after it has
  pushed the record it wrote, so pushes reach `TauriUnitRunner` in write order.
  `server_set_run_policy` pushes only the policy (`set_unit_policy`).
  `server_update` pushes the record again only when
  `ServerRecord::run_inputs_differ` says a field a run reads changed: every
  field but the run policy. The launcher and Authorization URLs are a run's:
  its `/oauth/sign-in` may send a browser on to them. A new field needs a
  decision there. Either pushes the whole record when `ServerUnits::holds` says
  `TauriUnitRunner` doesn't hold the server, as when `servers.json` was
  unreadable at launch.
- **Stop, then delete.** `server_remove` awaits `TauriUnitRunner`'s
  `remove_unit`, so the server's run has ended, then deletes its folder and its
  record. A deletion that fails pushes the server back as `servers.json` holds
  it, with the `Off` policy `remove_server` stored first.
- **One `server-status` per change.** The host emits a server's
  `ServerStatus` to the `main` webview whenever its `UnitStatus` changes (its
  newest pending consent included), camelCase, each optional member left out
  when absent:
  `{domain, runState, lastStop?: {reason, platformReason?, error?,
  stoppedAt}, runningSince?, health?, tunnel?, certificate,
  pendingConsent?}`, `tunnel` `{kind}` of `connecting`, `connected`,
  `tokenRejected` or `tunnelUnknown`, or `{kind: "reconnecting", error}`,
  `certificate` always there, and `pendingConsent` `{kind: "device",
  userCode, clientName}` or `{kind: "oauth", id, clientName}` while a
  consent waits. A removed server gets no event; the
  base drops a server once `servers_list` no longer lists it, and reads the
  list again after `server_remove` and for a status of a server it doesn't
  list. `servers-wire-golden.json` pins the list and the event, and the
  relays and credentials `server_add` takes and the `EnrolmentError`s it
  answers, read by both
  `servers-rust`'s tests and `servers-core-js`'s decoder tests: change both
  sides with it.
- **Status comes from `UnitRunner`.** Whether a server is running, why it
  last stopped, its health and its tunnel's state are `UnitRunner`'s `UnitStatus<ServerDetail>`,
  from `statuses()` / `subscribe()`, and each run's stop is
  `subscribe_stops()`'s; nothing in these packages tracks runs itself.
  A run's health, tunnel state and certificate state go out through
  `ctx.set_detail`, and `UnitRunner` clears them.
- **Consents are decided on the server's own pages.** The base never decides
  one: `server_open_pending_consent` (`{domain}`) opens the consent waiting
  first on a server, and `server_open_notified_consent`
  (`{notificationId}`) the one a tapped consent notification is for
  (`server_of_consent_notification`; any other notification opens nothing).
  Each checks the server as `server_launch` does, then opens
  `consent_sign_in_url`: `/oauth/sign-in` with a same-device sign-in code,
  `next` the path `/oauth/authorize/{id}/consent?then=back` or
  `/oauth/device?user_code=…&then=back` (the sign-in takes a path on the
  server as `next`, not an absolute URL). `then=back` makes the page go back
  or close once decided, rather than follow the client's callback. The view
  is a launch view, opened over the views showing (`OpenMode::Stack`) rather
  than replacing or joining them, so the page under it, as an app's waiting
  for that consent, stays where it was: on iOS it shows over the top-most
  view, on Android it opens a Custom Tab of its own, and a desktop opens a
  default-browser tab. On iOS the base then waits on the run's
  `ServerConsentWatcher` and closes the view once the request is decided or
  expires, revealing the page under it, unless the user closed it first; a
  Custom Tab and a desktop's tab can't be closed by the app. Further errors
  are `nothingPending` and the launch's.
- **Launching opens the launcher with a launch for any client, signed in.**
  `server_launch` (`{domain}`) reads the record's launcher URL, refuses at
  once unless `ensure_launchable` passes for the server's status, the one
  the base receives (its run is up, its `tunnel` neither `tokenRejected` nor
  `tunnelUnknown`, checked before the health, which may predate it, its
  `health` `reachable`, its
  `certificate`, the run's or else the cache's, `noRenewalNeeded` or
  `renewalDue` and from a CA browsers trust,
  `CertificateAuthority::is_browser_trusted`), mints a launch through the `ServerLaunchMinter` in the
  run's detail on a blocking thread, and builds `launch_url`: the launcher
  URL with `iss=https://<domain>` and `launch` in its query, any
  earlier `iss` or `launch` dropped and its other parameters kept as
  written. The launch binds no OAuth client, so
  any app can be a launcher. It opens `sign_in_url`,
  `https://<domain>/oauth/sign-in?code=…&next=<launch URL>`, with a
  same-device sign-in code minted through the `ServerSignInCodeMinter` in
  the run's detail, so the browser is signed in as the Owner and the launch's
  own sign-in reaches the server's consent card rather than its wait page. `server_open_authorization_app` (`{domain}`) opens the record's
  Authorization URL with `iss=https://<domain>` (`authorization_app_url`,
  any earlier `iss` dropped) through the same sign-in, with the same check,
  view and presence, and mints no launch. The page opens in the in-app browser
  (`tauri-plugin-native-page-browser`), replacing the views showing
  (`OpenMode::Replace`): on iOS a launch replaces the views earlier opens
  showed, and on Android a launch that arrives while an earlier view is still
  opening joins it. Each view is reported to
  `TauriUnitRunner` under an id of its own (`launch-<n>`) until the browser
  reports it closed (on Android, as the app resumes from under it); on
  Android, where the view moves the app to the background, an open view keeps
  the app present for `WhileOpen`, and a background session keeps it alive
  under the view until the browser reports it keeps the app alive itself
  (`KeptAlive`, `launch_view_kept_alive`). It never changes the run policy. Errors are
  `{kind, message}`: `serverNotRunning`, `tokenRejected`, `tunnelUnknown`,
  `notYetProbed`, `unreachable`, `noValidCertificate`, `untrustedCertificate` (a valid certificate from
  Let's Encrypt's staging CA), `authorizationServer`, `openingBrowser`, or the registry's
  `notRegistered` or `registry`. The golden file pins the refusals the base
  shows and which CAs browsers trust.
- **One notification per request, newest first.** A run's authorization
  server publishes its newest pending consent, named for the client that
  asks, on the run's own channel; the run sets it as
  `ServerDetail::pending_consent`, and the server's status carries it as
  `pendingConsent`. Requests stack: a new one takes over, and deciding it
  brings back the one before. `ConsentNotificationCoalescer` picks, from
  `UnitRunner`'s statuses, each server whose newest request is one it hasn't
  notified for, and the host posts "‹client› wants access to ‹domain›" under
  `consent-request:<domain>`, replacing the server's last. A request made by
  a browser signed in as the Owner (`requested_by_owner_browser`, which
  `/oauth/authorize` records when it sends that browser to the consent card),
  as one a launch opened, neither notifies nor opens: the Owner is already
  looking at its consent card. It still counts as the server's newest, and
  the server's page still shows it as the pending request. On a phone the
  host withdraws it once the request is no longer the server's newest
  (decided or expired, or another it notified for is newest again), or the
  server is removed. A tap opens it on a phone. On a phone the host also
  opens, at the app's start, the request a server reports in its run's first
  status since then, instead of notifying for it, so a request whose
  notification launched the app opens: once per app start, for the first
  such server in domain order, while any other's notifies; one the Owner's
  own browser made doesn't open, since that browser died with the app. A
  desktop can't click a notification, so there the host also opens each
  request it notifies for at once in the default browser, as the server's
  page's Open does. Either open waits for the server: one that can't open it
  then, as one not launchable yet at the app's start, opens it on a later
  status change once it can, while it is still the server's newest request
  (`open_consent_once_openable`). `ConsentNotificationCoalescer` decides
  which requests notify and which open (`ConsentOpening`). A request already notified for, as when it
  comes back once a newer one is decided or after a run restarts, doesn't
  notify again. A server forgets the requests it notified for once its run
  reports nothing pending, and keeps at most 32 meanwhile. The golden file
  pins the wire shape.
- **A certificate's state is its run's, or its cache's.** Every
  `ServerStatus`, in the `server-status` event and in `servers_list`,
  carries one. While a run has reported one
  (`ServerStatus::run_certificate`), it is the run's, from its
  `ServerDetail`: `ordering`, `noRenewalNeeded`, `renewalDue` or
  `orderFailing`, with the last error: an order's, or a `cache` fault, which
  never makes it `orderFailing`. With none, as for a stopped or starting
  server, the host reads what the certificate cached in the server's
  `certificates/` folder says
  (`wildflowerhealthio_wildflower_server::cached_certificate_state`) when it emits the
  status or answers `servers_list`, only for those servers, and
  concurrently: `notIssued`, `noRenewalNeeded`, `renewalDue` or `expired`,
  or `cacheUnreadable` with the error, never `ordering` or `orderFailing`.
  So a stopped server never shows its last run's `orderFailing`. A stopped
  server's certificate lapses and renews when the server starts, so
  `expired` is not a failure. A listed server's `certificate` is its
  status's. The certificate state's wire
  shape is `{status, issuer, held?: {notBefore, notAfter, fingerprint},
  lastError?: {kind, …}}`.
- **Each new certificate is recorded once.** A run appends each certificate
  it deploys that the history doesn't record already to `certificates/history.json`
  (`wildflowerhealthio_wildflower_server::read_certificate_history`), so it is deleted with
  the server.
- **Notification decisions are pure.** A new rule goes in `servers-rust`'s
  `domain/notifications/` with its tests; `servers-tauri` only posts.
- **Configuration only.** `ServerRecord::run_policy` is when the user wants
  the server run. Whether a run is up, its reachability and its certificate
  are live state, held by whatever runs the server, never in a
  `ServerRecord`.
- **The run policy is the unit runner's `RunPolicy`.** `servers-rust` stores
  `wildflowerhealthio_unit_runner::RunPolicy` itself, no mirror, in its wire shape:
  `{"kind": "off"}`, `{"kind": "whileOpen"}`,
  `{"kind": "until", "at": "<RFC 3339>"}` or `{"kind": "always"}`. The app
  stores it and pushes it to `UnitRunner`; `UnitRunner` never reads
  `servers.json`. "Wants it running now" is
  `RunPolicy::wants_running(now, true)`: the app is present whenever the user
  acts or the host starts.
- **The user picks a `RunPolicyChoice`.** `off`, `whileOpen`,
  `for {seconds}` or `always`. `RunPolicyChoice::into_run_policy_at(now)`
  stores `for` as `until {at: now + seconds}`; zero seconds or less is
  `ServerChangeError::NonPositiveDuration`, and a deadline after the year 9999
  `ServerChangeError::DurationOutOfRange`.
- **An expired `until` stays.** Nothing rewrites a policy when its deadline
  passes; it only stops wanting its server running. Only the user's choices
  write a policy.
- **No cap on running servers.** `set_run_policy` changes only the server it
  names; every other server keeps its policy, so several can want their
  servers running at once. A server binds no port, so they run side by
  side, each reached through its own tunnel.
- **A new server runs if nothing else does.** `add_server` gives a new server
  `whileOpen` when no registered server's policy wants it running, and `off`
  otherwise. An `off` policy or an `until` that has passed doesn't.
- **Each change is one registry modify.** `set_run_policy`,
  `update_server` (launcher URL, Authorization URL and certificate authority) and
  `set_server_credentials` (token and `public_settings`) each edit only their
  own fields inside one `ServerRegistry::modify`, so a change made
  concurrently, such as a run policy set while a token is checked with the
  relay, is kept. A server that isn't registered is
  `RegistryError::NotRegistered`, with nothing written.
- **Removal turns the server off, then deletes the folder first.**
  `remove_server` stores the run policy `Off`, then deletes
  `<data root>/servers/<domain>/`, its certificates with it but not the
  install's ACME account, and then the record, so a folder that can't
  be deleted (`ServerChangeError::DeletingFolder`) leaves the server
  registered and the removal can be retried; a folder already gone is fine.
  A deletion that fails partway leaves the server registered with part of its
  folder, some databases or certificates possibly gone, and `Off`, so it
  doesn't run on what's left; retrying deletes the rest.
- **A launcher or Authorization URL is checked when entered.**
  `update_server` takes an absolute `http` or `https` URL with a host and no
  credentials for each, or refuses it as
  `ServerChangeError::InvalidLauncherUrl` or `InvalidAuthorizationUrl`.
- **`servers.json` is versioned.** The file is
  `{"version": 3, "servers": [...]}`, its server fields `serde(remote)`
  mirrors of `ServerRecord` and `PublicRatholeSettings` renamed to camelCase,
  which the compiler keeps in step with those types. A change to the stored
  shape bumps the version, with a migration from the previous one: a version
  2 file, whose servers have no `authorizationUrl`, is read with the default
  Authorization app as each server's; a version 1 file, whose servers have a
  boolean `stagingCertificates`, is read with each server's
  `certificateAuthority` (`true` is `letsEncryptStaging`, `false`
  `letsEncrypt`), then as version 2. Either is written as version 3 by the
  next change. Any other version this build doesn't read is
  `RegistryError::UnsupportedVersion`, and the file is neither read nor
  overwritten.
- **Writes are atomic.** Every change writes the whole document to
  `.servers.json.tmp` beside the file, fsyncs it, renames it over
  `servers.json` and fsyncs the directory, so a crash leaves either the old
  file or the new one.
- **The base reaches the host only through Tauri commands.** Every call goes
  through `servers-core-js`'s `invokeHostCommand`, which decodes the answer with
  the command's schema, so nothing the host sends is trusted by its static
  type. The base mounts no effect-messaging transport; the host shell's one
  serves the Recorder tab alone. A command the base
  calls is granted to the `main` webview in
  `apps/host/host-app/src-tauri/capabilities/default.json`; the server
  commands through the app-defined `allow-server-enrolment` and
  `allow-server-management` permissions, and the notification taps through
  `notification:allow-register-listener`.
- **The server page reads `/health` itself.** While a server runs, its page
  reads `https://<domain>/health` with `servers-core-js`'s `readServerHealth`,
  through the router context's `runHttpRequest` (`FetchHttpClient.layer` in
  the app; a stub layer `ServersRouterContext.make` takes as `httpClient` in tests). It is
  public and its tunnel listener answers with CORS outermost, so an answer
  shows the whole path, webview to relay to tunnel to server, working. `200`
  and `503` both carry the report; any other status is an error the page
  shows. It is read once per run, keyed by the server's domain and
  `runningSince`, so a new run reads it again; nothing polls, and Refresh
  reads it on request. The host's own `health` in `server-status` stays the
  status the card and badge show.
- **The base enables the background session's recovery.** Once its consent is
  answered, `BaseGate` calls the background-service plugin's
  `configure_recovery` with the start config the app passes, read from
  `tauri-shared-config.json`, the file the host's `TauriUnitRunner` is built
  from.
- **The base asks for its own telemetry consent.** `BaseGate` is a
  `TelemetryConsentGate` with `WILDFLOWER_HOST_TELEMETRY_CONSENT_COPY`, around
  the app's whole router; until it is answered no router or query cache exists
  and no host command is called. The answer starts telemetry with the DSN the app passes, from
  `VITE_SENTRY_DSN_HOST_APP`, tagged `app: host-app`. The web
  app's consent is its own, on its own origin.
- **`servers-rust` has no `tauri` dependency**, so it builds and tests in the
  non-Tauri partition of `scripts/checks/rust.sh`. Its one unit runner
  dependency is `unit-runner-rust`, the Tauri-free `UnitRunner`, and the
  server it runs is `wildflower-server-rust`, Tauri-free too.
  `servers-tauri` depends on `tauri-unit-runner-rust` and is in the Tauri
  partition.

## References

- [Server Runs Explanation](./docs/Server%20Runs%20Explanation.md) — how the
  host runs the servers on the unit runner, the notifications, and the
  background-service packaging.
- [unit-runner Design Explanation](../unit-runner/unit-runner-rust/docs/Design%20Explanation.md)
  — `UnitRunner`'s contract and vocabulary.
- [wildflower-server-rust AGENTS.md](../wildflower-server/wildflower-server-rust/AGENTS.md) — the server
  each run sets up and serves.
- [slices/AGENTS.md](../../../slices/AGENTS.md) — slice layering rules these packages follow.
- `slices/rathole-settings-rust` — `PublicRatholeSettings`, the
  `GET /rathole` response a record keeps as `public_settings`,
  `TunnelHost`, the `GET /me` response, `ClaimRequest` and `ClaimedTunnel`,
  `POST /claim`'s, and `TunnelName`.
- `apps/relay/relay-server` — the relay whose `GET /rathole`, `GET /me` and
  `POST /claim` enrolment calls; its crate docs give the signing rules.
