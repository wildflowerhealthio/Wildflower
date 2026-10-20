# OAuth Router

{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/mod.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/openapi.rs}}

Everything under `/oauth` is reached **before anyone holds a bearer token**. An app's browser arrives at the front door, an app's back end trades a code for tokens, a device asks for a code to show its user, a browser asks to be paired. None of them is the Owner, so none of these routes sits behind the `/authorization` session gate. Each answers its caller from what the request itself proves: a browser session cookie, a client's credentials, a code.

The `oauth` folder holds two route tables, mounted side by side under the same prefix. **The API table is documented; the page table isn't.** An app or a device talks to the API routes, and the `OpenAPI` spec is collected from them. A browser shows the pages, which are no API surface, so they stay out of the spec. The HTTP layer's [`router`](<../../HTTP Explanation.md#item-http--router>) mounts both.

## `http::routes::oauth`

### `OAUTH_MOUNT`

The [device page's URL](<Authorization Pages Explanation.md#item-device_page_url>) and the limited page's next stop are built from it.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/mod.rs OAUTH_MOUNT}}

### `openapi_router`

**Two routes start an authorization request, and only those two are limited** by [`limit_authorization_starts`](<../Middleware Explanation.md#item-limit_authorization_starts>), each named by its [`AuthorizationStartRoute`](<../Middleware Explanation.md#item-AuthorizationStartRoute>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/mod.rs openapi_router}}

### `page_router`

The authorization pages need `launcher_base` too: their **Sign out** form must be allowed to follow the sign-out's redirect, so their content security policy names the launcher's origin ([`sign_out_form_targets`](<Authorization Pages Explanation.md#item-sign_out_form_targets>)).

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/mod.rs page_router}}

## `http::routes::oauth::openapi`

The token-style handlers parse a body without client credentials: the [`TokenRequest`](<Token Endpoint Explanation.md#item-TokenRequest>) extractor reads `client_id` and `client_secret` from the same form body, or from `Authorization: Basic`, on its own. What arrives on the wire still carries them, so the spec models each body with the credentials put back. These types are never built; they exist for `#[utoipa::path]` to name.

### `TokenRequestBody`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/openapi.rs TokenRequestBody}}

### `DeviceAuthorizationRequest`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/openapi.rs DeviceAuthorizationRequest}}

### `TokenRevocationRequestBody`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/openapi.rs TokenRevocationRequestBody}}

### `AuthorizationRequestNotFound`

The serving side renders this `404` as [`AuthorizationRequestNotFoundBody`](<../Errors and Wire Shapes Explanation.md#item-AuthorizationRequestNotFoundBody>); the spec models it here, for the status poll and the limited page's calls to name.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/openapi.rs AuthorizationRequestNotFound}}
