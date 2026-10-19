# Client

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/client.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/client_registration.rs}}

A **client** is an app that asks for access to the Owner's FHIR server: a SMART app in a browser, a Pebble companion, the host app. It names itself with a `client_id` on every request. A client that can keep a secret is **confidential** and authenticates with one; a client that can't (a single-page app, a native app) is **public**.

Every client has a **registration**: the redirect URIs it may send a browser back to, the scopes it may ask for, and the grant types it may use at `/token`. **Who defines the registration decides how a request is judged against it.** A few clients belong to the server itself, and their registration is fixed: a request is held to it as it stands. Every other client is **trusted on first use**. An app the server has never seen isn't turned away at `/authorize`. Its request goes to the Owner with a warning, and the Owner's approval writes the registration, or widens it when a known app steps outside what it registered.

That warning is the **registration verdict**: is this request inside the registration, from an app the Owner has never approved, or would approving it widen what the app already has? The verdict is derived from the current row on every read, never stored, so a consent prompt opened after the row moved shows the move.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/client.rs Client}}

| Field                          | The fact it records                                                                                             |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `client_id`                    | The app's public name for itself, sent on every request.                                                        |
| `name`                         | What the consent card calls the app.                                                                            |
| `kind`, `secret_hash`          | Whether the app can keep a secret, and the argon2id hash of it when it can.                                     |
| `redirect_uris`                | Where the app may send a browser back to. Matched exactly.                                                      |
| `allowed_scopes`               | What the app may ask for. Matched by coverage: a broad scope admits the narrower ones it covers.                |
| `allowed_grant_types`          | Which grants the app may redeem at `/token`; any other is refused with `unauthorized_client`.                   |
| `registered_at`, `disabled_at` | When the app was registered, and when it was disabled. A disabled app gets nothing at `/authorize` or `/token`. |
| `registration_source`          | Who defines the registration: the server, or the Owner's approvals.                                             |

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/client.rs ClientKind}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/client.rs AllowedGrantType}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/client.rs RegistrationSource keep-docs}}

A **server-defined** registration belongs to one of the server's own clients (the host app's, the browser-session client, the FHIR server UI's). Boot-time seeding rewrites it on every boot, and an approval never writes it. A **trusted-on-first-use** registration is created by the Owner's first approval of an unknown app and widened by any later approval of a request outside it.

## Test fixtures

The unit tests build clients from the shared fixture: a public client named `<client_id> display name`, registered for the one redirect `https://example.com/cb`, allowed every grant type, trusted on first use, with the scopes the test passes.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs client}}

`owned_scopes` turns string literals into the owned scope list a method takes.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs owned_scopes}}

The registration tests present every request at the fixture's own redirect, unless they say otherwise.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/client_registration.rs tests::redirect}}

`classify` judges a presented redirect and scope list against a client row, or against no row.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/client_registration.rs tests::classify}}

`resolve` resolves a request from the client `app` at the fixture redirect.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/client_registration.rs tests::resolve}}

The property tests draw scope strings with no scope-grammar characters, so coverage is plain equality and the properties can be stated as set membership.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/client_registration.rs tests::arb_plain_scope}}

## `ALL`

Every grant the token endpoint supports. It is the allow-list the host app's seeded client gets, and so does a trusted-on-first-use client that an approval creates.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/client.rs AllowedGrantType::ALL}}

No unit test of its own.

## `registration_is_fixed`

**A server-defined registration is fixed**: a request is held to it as it stands, and approving one never widens it. Every other registration can grow with the Owner's approvals.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/client.rs Client::registration_is_fixed}}

No unit test of its own; [`a_server_defined_registration_is_fixed`](#resolve) shows what a resolved request makes of it.

## `allows_redirect_uri`

**A redirect is allowed only if it is on the list, exactly.** No prefix or pattern matching. This is the one redirect check: `/authorize`, the consent read path and the approval that widens a registration all ask it, so a prompt can't disagree with the endpoint that parked its request.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/client.rs Client::allows_redirect_uri}}

No unit test of its own; the registration verdicts below exercise it.

## `allows_scopes`

**A client may ask for any scope one of its allowed scopes covers.** Coverage, not spelling: an app allowed `patient/*.rs` may ask for `patient/Observation.r`. The device flow asks this at `/device_authorization`, which refuses a request that steps outside.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/client.rs Client::allows_scopes}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/client.rs Client::allows_scope}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/client.rs allows_scopes_tests::allows_scopes_is_coverage_aware}}

A narrower scope under `patient/*.rs`, with `openid`, is allowed, and so is asking for nothing; a create permission and a `system/` context outside the list are not.

## `ClientRegistrationVerdict`

How an authorization-code request compares with its app's registration. The consent card renders it as the warning the Owner reads before approving.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/client_registration.rs ClientRegistrationVerdict keep-docs}}

| Verdict      | What the Owner is told                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------- |
| `Registered` | Nothing new: the redirect is registered and every scope is covered.                                     |
| `New`        | The Owner has never approved this app. Nothing about it is stored until they do.                        |
| `WouldWiden` | The app is known, but this request steps outside its registration: a new redirect, new scopes, or both. |

## `is_registered`

**Only a request that matches its registration exactly may use a standing grant.** `/authorize` skips the Owner when an earlier grant already covers the request, and this is the gate on that shortcut: a new app, a new redirect or a new scope always goes back to the Owner.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/client_registration.rs ClientRegistrationVerdict::is_registered}}

No unit test of its own.

## `needs_acknowledgement`

**Approving anything but a registered request takes the Owner's explicit acknowledgement** that the app, its redirect or its scopes are new to them. An approval without it is refused.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/client_registration.rs ClientRegistrationVerdict::needs_acknowledgement}}

No unit test of its own.

## `classify_registration`

The verdict itself. A request **presents** a registration (its redirect and its scopes), and that is judged against the app's row as it stands. No row is `New`. A redirect off the list or any uncovered scope is `WouldWiden`, carrying which of the two stepped outside. Otherwise `Registered`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/client_registration.rs PresentedClientRegistration}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/client_registration.rs classify_registration}}

A scope string the scope grammar can't parse covers only itself, so the Owner sees it as new unless the registration lists it verbatim.

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/client_registration.rs tests::an_unknown_client_is_new}}

With no row, the request is `New`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/client_registration.rs tests::an_allowlisted_redirect_with_covered_scopes_is_registered}}

The registered redirect with a registered scope is `Registered`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/client_registration.rs tests::a_scope_covered_by_a_broader_registered_scope_is_registered}}

A narrower scope under a broader registered one is `Registered` too.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/client_registration.rs tests::an_unregistered_redirect_is_changed_without_new_scopes}}

A new redirect with registered scopes would widen the redirect list only.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/client_registration.rs tests::an_unparseable_scope_is_new_unless_registered_verbatim}}

An unparseable scope is `Registered` when listed verbatim, and new when anything else is listed.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/client_registration.rs tests::verdict_agrees_with_what_it_reports}}

For any registered and requested scopes, with the redirect on the list or off it: a known app is never `New`, `Registered` means nothing stepped outside, and `WouldWiden` reports exactly the new redirect and the uncovered scopes, in request order, with at least one of them set.

## `uncovered_scopes`

The requested scopes no allowed scope covers, in the order the request gave them: the scope half of the verdict.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/client_registration.rs uncovered_scopes}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/client_registration.rs tests::uncovered_scopes_are_reported_in_request_order}}

Of `write`, `read`, `admin` against a registration of `read`, the verdict reports `write` then `admin`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/client_registration.rs tests::unioning_the_requested_scopes_makes_the_next_request_registered}}

Adding everything requested to the allowed scopes, as an approval does, leaves nothing uncovered, so the next identical request is `Registered` and may use the standing grant.

## `ResolvedCodeRequest`

An authorization-code request **resolved against its app's registration** as it stands now. It is the one place `/authorize`, the limited page's Continue, and the consent read and approval learn what the app's row says about a request: the app's name, whether it is disabled, whether its registration is fixed, whether the redirect is registered, the verdict, and the scopes an approval may grant.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/client_registration.rs ResolvedCodeRequest}}

Its getters return those facts as they were resolved: `client_name` (the registered name, or the `client_id` for an app with no row), `client_disabled`, `registration_is_fixed`, `redirect_is_registered` (the only case an error may be sent back to the redirect), `registration_verdict` and `approvable_scopes`.

{{#covered apps/host/wildflower-server/authorization-server-rust/src/domain/client_registration.rs ResolvedCodeRequest::client_name ResolvedCodeRequest::client_disabled ResolvedCodeRequest::registration_is_fixed ResolvedCodeRequest::redirect_is_registered ResolvedCodeRequest::registration_verdict ResolvedCodeRequest::approvable_scopes}}

## `resolve`

Resolve a request once, from what it presents and the app's row (or no row). An app with no row is named by its `client_id`, is neither disabled nor fixed, and has no registered redirect. The approvable scopes come from {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs ApprovableScopes::for_code}}, which caps a fixed registration at itself.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/client_registration.rs ResolvedCodeRequest::resolve}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/client_registration.rs tests::an_unknown_client_resolves_as_new_under_its_id}}

An unknown app is called `app`, is not disabled or fixed, has no registered redirect or scopes, and is `New`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/client_registration.rs tests::a_server_defined_registration_is_fixed}}

A server-defined app asking for `read` and `write` with only `read` registered is fixed, its redirect registered, its scopes not; an approval may grant only `read`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/client_registration.rs tests::a_disabled_client_resolves_disabled}}

A disabled app resolves as disabled, and its verdict is still `Registered`: being disabled is a separate fact.

## `scopes_are_registered`

**Whether every requested scope is inside the registration**, whatever the redirect. A new app has no registered scopes. A fixed registration is held to this: `/authorize` refuses a server-defined app's request with `invalid_scope` when it is false.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/client_registration.rs ResolvedCodeRequest::scopes_are_registered}}

The [`resolve`](#resolve) tests above assert it for a new app, a fixed one and a disabled one.
