# Device Authorization

{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/device_authorization.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/device_name_hint.rs}}

A device with no good browser of its own, a command line or a TV app, asks for access the RFC 8628 way. **The device gets two codes: one to poll with, one for a person to type.** It shows the user code and the device page's address; the Owner opens the page, confirms the code, and decides. Meanwhile the device polls the [token endpoint](<Token Endpoint Explanation.md#handle_token_request>) with its device code until the decision lands.

`POST /oauth/device_authorization` is the first step. Its caller is the device's client, authenticated as at the token endpoint. Every device request is raised for the Owner, so every one spends from the authorization start limit.

## `DeviceAuthorizationPayload`

The form body: the scopes asked for, and an optional name for the device, a non-standard extension the approver sees. The client's credentials aren't parsed here: RFC 8628 §3.1 inherits RFC 6749's client authentication, which the [`TokenRequest`](<Token Endpoint Explanation.md#tokenrequest>) extractor owns, from the `Authorization: Basic` header or the body.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/device_authorization.rs DeviceAuthorizationPayload}}

## `DeviceAuthorizationResponse`

The RFC 8628 §3.2 answer. `verification_uri` is the [device page](<Authorization Pages Explanation.md#device_page_url>); `verification_uri_complete` is the page with the code [filled in](<Authorization Pages Explanation.md#device_page_url_with_code>), which still asks the Owner to confirm the code before it reads the request.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/device_authorization.rs DeviceAuthorizationResponse}}

**It is never cached**: RFC 8628 §3.2 inherits RFC 6749 §5.1's `no-store`, and rendering through `CacheSuppressed` makes that part of the value.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/device_authorization.rs DeviceAuthorizationResponse::into_response}}

## `handle_device_authorization_request`

The handler, in the order its extractors run. The start limit is asked first, before the body is read: a start the limit's layer [deferred](<../Middleware Explanation.md#startlimitaskednow>) for a browser that can decide consents is asked now, since a device request is raised for the Owner whoever sends it, and a refusal is the `429`. The `User-Agent` is read next. The [`TokenRequest`](<Token Endpoint Explanation.md#tokenrequest>) extractor comes last, as it consumes the body: it checks the content type, parses the payload and authenticates the client, and any failure is a [`TokenError`](<Token Endpoint Explanation.md#tokenerror>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/device_authorization.rs handle_device_authorization_request}}

Exercised end to end by [`device_authorization_happy_path`](<../../Integration Tests/OAuth Endpoints Explanation.md#device_authorization_happy_path>), [`device_authorization_unknown_client_returns_401`](<../../Integration Tests/OAuth Endpoints Explanation.md#device_authorization_unknown_client_returns_401>), [`device_authorization_with_basic_auth_issues_device_code`](<../../Integration Tests/Client Auth Explanation.md#device_authorization_with_basic_auth_issues_device_code>), [`device_authorization_sets_cache_suppression_headers`](<../../Integration Tests/Device Code Explanation.md#device_authorization_sets_cache_suppression_headers>) and [`a_device_start_asks_the_gate_whatever_the_browser_session`](<../../Integration Tests/Authorization Start Limit Explanation.md#a_device_start_asks_the_gate_whatever_the_browser_session>).

## `device_authorization`

The work: split the scopes on whitespace, settle on a name, and hand the request to [`DeviceAuthorizer::start`](<../../Capabilities/OAuth/Device Authorizer Explanation.md#start>), which parks it.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/device_authorization.rs device_authorization}}

**The name the approver sees** is the one the client chose, trimmed, when it isn't blank. A client that didn't name itself is named from its `User-Agent`, when that names a browser or a system ([`device_name_from_user_agent`](#device_name_from_user_agent)). With neither, the request has no name, and the approval falls back to the client's.

| Failure                                | Response                                              |
| -------------------------------------- | ----------------------------------------------------- |
| a scope the client may not ask for     | `400` `invalid_scope`, "Scope not allowed for client" |
| no unused user code could be generated | a logged, uncached `500`                              |
| a store failure                        | a logged, uncached `500`                              |

Exercised end to end by [`device_authorization_carries_device_name_to_consent`](<../../Integration Tests/Device Code Explanation.md#device_authorization_carries_device_name_to_consent>), [`device_authorization_infers_device_name_from_user_agent_when_unnamed`](<../../Integration Tests/Device Code Explanation.md#device_authorization_infers_device_name_from_user_agent_when_unnamed>), [`explicit_device_name_wins_over_user_agent_inference`](<../../Integration Tests/Device Code Explanation.md#explicit_device_name_wins_over_user_agent_inference>) and [`device_authorization_allows_scope_covered_by_client_wildcard`](<../../Integration Tests/OAuth Endpoints Explanation.md#device_authorization_allows_scope_covered_by_client_wildcard>).

## `device_name_from_user_agent`

A friendly name for the approver, guessed from a `User-Agent`: "Chrome on macOS" when it names a browser and a system, the one it names otherwise, and nothing for the many clients whose agent names neither (a command line, a bare HTTP library). **A raw agent string is never shown as a name.** It names a device that didn't name itself here, and a browser starting a [pairing](<Pairing and Sign In Explanation.md#handle_browser_pairing_start>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/device_name_hint.rs device_name_from_user_agent}}

It is a small substring check, not an agent database. **The more specific token is tested first**, since agents embed the tokens of what they derive from: Chromium forks carry `Chrome/`, Chrome carries `Safari/`, and the iOS and Android agents carry `Mac OS X` and `Linux`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/device_name_hint.rs browser}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/device_name_hint.rs operating_system}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/device_name_hint.rs tests::desktop_browsers_render_as_browser_on_os}}

Chrome on a Mac and Firefox on Windows are named browser on system.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/device_name_hint.rs tests::chromium_forks_win_over_the_embedded_chrome_token}}

Edge, which carries `Chrome/` too, is named Edge.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/device_name_hint.rs tests::safari_only_when_not_chromium}}

Safari on an iPhone, which carries `Mac OS X`, is named Safari on iPhone.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/device_name_hint.rs tests::android_wins_over_the_linux_token_it_embeds}}

Chrome on Android is named Android, not Linux.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/device_name_hint.rs tests::non_browser_clients_yield_none}}

`curl`, `okhttp`, Go's and Python's HTTP clients, and an empty agent get no name.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/device_name_hint.rs tests::a_lone_os_still_names_the_device}}

A native app naming only its system is named after the system.
