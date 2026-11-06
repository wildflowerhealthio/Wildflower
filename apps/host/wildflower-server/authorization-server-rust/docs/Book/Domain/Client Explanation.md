# Client

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/client/mod.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/client/kind.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/client/registration_source.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/client/presented_change.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/essential_client.rs}}

A **client** is an app that asks for access to the Owner's FHIR server: a SMART app in a browser, a Pebble companion, the host app. It names itself with a `client_id` on every request. A client that can keep a secret is **confidential** and authenticates with [its credentials](<Client Credentials Explanation.md>); a client that can't (a single-page app, a native app) is **public**.

Every client has a **registration**: the redirect URIs it may send a browser back to, the scopes it may ask for, and the grant types it may use at `/oauth/token`. **Who defines the registration decides how a request is judged against it.** A few clients belong to the server itself, and their registration is fixed: a request is held to it as it stands. Every other client is **trusted on first use**. An app the server has never seen isn't turned away at `/oauth/authorize`. Its request goes to the Owner with a warning, and the Owner's approval writes the registration, or widens it when a known app steps outside what it registered.

That warning is the **presented client change**: what approving the request would change in the app's registration. Nothing, if the request stays inside it; create it, for an app the Owner has never approved; or widen it, by a new redirect, new scopes, or both. The change is derived from the current row on every read, never stored, so a consent prompt opened after the row moved shows the move. A request that would change the registration never skips the Owner, even when a [standing grant](<Grant Explanation.md>) would cover it.

Two clients the Owner can't switch off at all, because they are how the Owner gets in: they are **essential**.

## `domain::client`

### `Client`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/client/mod.rs Client}}

#### `is_registration_fixed`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/client/mod.rs Client::is_registration_fixed}}

#### `allows_redirect_uri`

**A redirect is allowed only if it is on the list, exactly**: no prefix or pattern matching.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/client/mod.rs Client::allows_redirect_uri}}

#### `allows_scopes`

**A client may ask for any scope one of its allowed scopes [covers](<Scopes Explanation.md#item-allowed_scope_covers>).** The device flow asks this at `/oauth/device_authorization`, which refuses a request that steps outside. The test builds its client from the [shared client fixture](<Test Fixtures Explanation.md#client>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/client/mod.rs Client::allows_scopes tests="allows_scopes_tests::allows_scopes_is_coverage_aware"}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/client/mod.rs Client::allows_scope}}

## `domain::client::kind`

### `ClientKind`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/client/kind.rs ClientKind}}

### `AllowedGrantType`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/client/kind.rs AllowedGrantType}}

#### `ALL`

The host app's seeded client is allowed every grant, and so is a client trusted on first use when an approval creates it.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/client/kind.rs AllowedGrantType::ALL}}

## `domain::client::registration_source`

### `RegistrationSource`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/client/registration_source.rs RegistrationSource}}

## `domain::client::presented_change`

The tests judge requests at the [presented-change fixtures'](<Test Fixtures Explanation.md#client>) redirect, against clients built from the shared client fixture.

### `PresentedClientChange`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/client/presented_change.rs PresentedClientChange}}

#### `from_presented_registration`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/client/presented_change.rs PresentedClientChange::from_presented_registration tests="tests::an_unknown_client_would_create_its_registration tests::an_allowlisted_redirect_with_covered_scopes_changes_nothing tests::a_scope_covered_by_a_broader_registered_scope_changes_nothing tests::an_unregistered_redirect_would_widen_without_new_scopes tests::an_unparseable_scope_is_new_unless_registered_verbatim tests::the_change_agrees_with_what_it_reports"}}

#### `would_change_registration`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/client/presented_change.rs PresentedClientChange::would_change_registration tests="tests::unioning_the_requested_scopes_makes_the_next_request_change_nothing"}}

### `PresentedClientRegistration`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/client/presented_change.rs PresentedClientRegistration}}

### `uncovered_scopes`

The scope half of the change.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/client/presented_change.rs uncovered_scopes tests="tests::uncovered_scopes_are_reported_in_request_order"}}

## `domain::essential_client`

The host app's client is how the Owner reaches the server at all, and the browser-session client is how a browser on the Owner's device signs in as the Owner. {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/clients.rs ClientsUpdater}} refuses to disable either, and the Owner's list of clients flags both.

### `is_essential_client`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/essential_client.rs is_essential_client tests="tests::only_the_host_app_s_and_the_browser_session_clients_are_essential"}}
