# Authorize

{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorize.rs}}

`GET /oauth/authorize` is the front door of the authorization-code flow. Nothing in the server calls it. An app finds it in the FHIR server's `.well-known/smart-configuration` and sends **the person's browser** here, with PKCE and a `state`. Everything the endpoint answers is for that browser: a redirect onward, or a page saying why it can't.

**No browser session, no authorization.** A browser that carries no live [browser session](<../../Domain/Browser Session Explanation.md>) is sent to the pairing page first, and nothing is parked, consumed or raised. A browser with one has its request handed to the [code authorization starter](<../../Capabilities/OAuth/Code Authorization Starter Explanation.md>), which validates it, parks it as a [code request](<../../Domain/Authorization Request/Code Request Explanation.md>) made in that session, and says where the browser goes next:

- back to the app with a code, when a [standing grant skips the Owner](<../../Domain/Grant Explanation.md#when-a-grant-skips-the-owner>): the request changes nothing in the app's registration, the grant covers every requested scope, and the session holds what the request needs or has gone on past the [limited page](<../../Domain/Authorization Request/Code Request Explanation.md#the-limited-page>) for this app before;
- to the limited page, when the session holds less than the request asks for and hasn't gone on for this app;
- to the consent card, when the [browser decides](<../../Domain/Authorization Request/Code Request Explanation.md#who-decides>) the request itself;
- to the wait page otherwise, with the request raised for the Owner.

A request that fails once its redirect is trusted goes back to the app with `error` and `state`. One that fails while its redirect isn't trusted gets a local `400` page, since redirecting there would be an open redirect. The [Grant Flows](<../../Integration Tests/Grant Flows Explanation.md>), [OAuth Endpoints](<../../Integration Tests/OAuth Endpoints Explanation.md>), [Session Required](<../../Integration Tests/Session Required Explanation.md>) and [Consent Card](<../../Integration Tests/Consent Card Explanation.md>) integration tests hold the endpoint to each of these answers.

## `http::routes::oauth::authorize`

### `AuthorizeParams`

A query missing any of the seven required parameters fails to deserialize, and axum answers its own `400` before the handler runs. The starter checks the values. A `launch` names a [launch context](<../../Domain/Launch Context Explanation.md>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorize.rs AuthorizeParams}}

### `handle_authorize_request`

It reads the browser session through [`carried_browser_session`](<../Browser Session Cookie Explanation.md#item-carried_browser_session>) before anything else, and passes the starter whether the session [can decide consents](<../Browser Session Cookie Explanation.md#item-can_decide_consents>). `may_raise_for_owner` asks the [deferred start limit](<../Middleware Explanation.md#item-DeferredStartLimit>), when the layer deferred one; with nothing deferred, the layer has already asked.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorize.rs handle_authorize_request}}

### `next_step_location`

The pages' locations come from [`consent_page_location`](<Authorization Pages Explanation.md#item-consent_page_location>), [`wait_page_location`](<Authorization Pages Explanation.md#item-wait_page_location>) and [`limited_page_location`](<Authorization Pages Explanation.md#item-limited_page_location>); the app's from the domain's [`build_client_redirect_url`](<../../Domain/Authorization Code Explanation.md#item-build_client_redirect_url>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorize.rs next_step_location}}

### `AuthorizeError`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorize.rs AuthorizeError}}

#### `from`

The starter's failures map onto it. A redirectable one has its `Location` built here, with [`build_client_error_redirect_url`](<../../Domain/Authorization Code Explanation.md#item-build_client_error_redirect_url>). A request the fast path found no longer pending, and a store failure, are both logged `500`s.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorize.rs AuthorizeError::from}}

#### `into_response`

The local page is [`oauth_error_html`](<../Errors and Wire Shapes Explanation.md#item-oauth_error_html>), and the `429` is the start limit's own [`start_limited_response`](<../Middleware Explanation.md#item-start_limited_response>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorize.rs AuthorizeError::into_response}}

### `found_redirect`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorize.rs found_redirect}}

### `html_bad_request`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorize.rs html_bad_request}}
