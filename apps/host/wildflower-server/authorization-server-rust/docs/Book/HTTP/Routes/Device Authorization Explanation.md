# Device Authorization

{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/device_authorization.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/device_name_hint.rs}}

A device with no good browser of its own, a command line or a TV app, asks for access the RFC 8628 way. **The device gets two codes: one to poll with, one for a person to type.** It shows the user code and the device page's address; the Owner opens the page, confirms the code, and decides. Meanwhile the device polls the [token endpoint](<Token Endpoint Explanation.md#item-handle_token_request>) with its device code until the decision lands. The request it parks is a [device request](<../../Domain/Authorization Request/Polled Requests Explanation.md>).

`POST /oauth/device_authorization` is the first step. Its caller is the device's client, authenticated by the [`TokenRequest`](<Token Endpoint Explanation.md#item-TokenRequest>) extractor as at the token endpoint. Every device request is raised for the Owner, so every one spends from the [authorization start limit](<../Middleware Explanation.md#httpmiddlewareauthorization_start_limit>). The [Device Code](<../../Integration Tests/Device Code Explanation.md>) and [OAuth Endpoints](<../../Integration Tests/OAuth Endpoints Explanation.md>) integration tests hold the route end to end.

## `http::routes::oauth::device_authorization`

### `DeviceAuthorizationPayload`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/device_authorization.rs DeviceAuthorizationPayload}}

### `DeviceAuthorizationResponse`

`verification_uri` is the [device page](<Authorization Pages Explanation.md#item-device_page_url>); `verification_uri_complete` is the page with the code [filled in](<Authorization Pages Explanation.md#item-device_page_url_with_code>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/device_authorization.rs DeviceAuthorizationResponse}}

#### `into_response`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/device_authorization.rs DeviceAuthorizationResponse::into_response}}

### `handle_device_authorization_request`

The start limit is asked through [`StartLimitAskedNow`](<../Middleware Explanation.md#item-StartLimitAskedNow>): a start the layer deferred for a browser that can decide consents is asked now, since a device request is raised for the Owner whoever sends it.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/device_authorization.rs handle_device_authorization_request}}

### `device_authorization`

The request goes to the [device authorizer](<../../Capabilities/OAuth/Device Authorizer Explanation.md>), which parks it.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/device_authorization.rs device_authorization}}

## `http::routes::oauth::device_name_hint`

**A raw agent string is never shown as a name.** The hint names a device that didn't name itself, and a browser starting a [pairing](<Pairing and Sign In Explanation.md#item-handle_browser_pairing_start>). It is a small substring check, not an agent database, and **the more specific token is tested first**, since agents embed the tokens of what they derive from: Chromium forks carry `Chrome/`, Chrome carries `Safari/`, and the iOS and Android agents carry `Mac OS X` and `Linux`.

### `device_name_from_user_agent`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/device_name_hint.rs device_name_from_user_agent tests="tests::desktop_browsers_render_as_browser_on_os tests::a_lone_os_still_names_the_device tests::non_browser_clients_yield_none"}}

### `browser`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/device_name_hint.rs browser tests="tests::chromium_forks_win_over_the_embedded_chrome_token tests::safari_only_when_not_chromium"}}

### `operating_system`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/device_name_hint.rs operating_system tests="tests::android_wins_over_the_linux_token_it_embeds"}}
