# Cache Suppression

{{#covers apps/host/wildflower-server/authorization-server-rust/tests/integration/cache_suppression.rs}}

Consent prompts, device prompts and the grants list are the Owner's private data. **No browser or shared cache may keep them: every response carries `Cache-Control: no-store` and `Pragma: no-cache`, once each.** On `/authorization` one layer, [`cache_suppress`](<../HTTP/Middleware Explanation.md#item-cache_suppress>), wraps every response, so handler output, the session gate's `401` and a handler's `404` all carry the headers. The `/oauth` handlers wrap their own responses in the same [`CacheSuppressed`](<../HTTP/Errors and Wire Shapes Explanation.md#item-CacheSuppressed>).

This file's own helpers are on the [Test Fixtures](<Test Fixtures Explanation.md#integrationcache_suppression>) page, with the shared ones.

## `integration::cache_suppression`

### `device_prompt_is_cache_suppressed`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/cache_suppression.rs device_prompt_is_cache_suppressed}}

Relies on [`cache_suppress`](<../HTTP/Middleware Explanation.md#item-cache_suppress>). Fixtures first used here: [`spin_up`](<Test Fixtures Explanation.md#item-spin_up>), [`seed_test_client`](<Test Fixtures Explanation.md#item-seed_test_client>), [`build_request`](<Test Fixtures Explanation.md#item-build_request>), [`body_json`](<Test Fixtures Explanation.md#item-body_json>), [`owner_get`](<Test Fixtures Explanation.md#item-owner_get>) and [`assert_cache_suppressed`](<Test Fixtures Explanation.md#item-assert_cache_suppressed>).

### `oauth_consent_prompt_is_cache_suppressed`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/cache_suppression.rs oauth_consent_prompt_is_cache_suppressed}}

Relies on [`cache_suppress`](<../HTTP/Middleware Explanation.md#item-cache_suppress>). Fixtures first used here: [`seed_client_with_redirect`](<Test Fixtures Explanation.md#item-seed_client_with_redirect>), [`get_authorize`](<Test Fixtures Explanation.md#item-get_authorize>), [`authorize_query`](<Test Fixtures Explanation.md#item-authorize_query>) and [`parked_request_id`](<Test Fixtures Explanation.md#item-parked_request_id>).

### `grants_list_is_cache_suppressed`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/cache_suppression.rs grants_list_is_cache_suppressed}}

Relies on [`cache_suppress`](<../HTTP/Middleware Explanation.md#item-cache_suppress>). Fixtures first used here: [`owner_grants_probe`](<Test Fixtures Explanation.md#item-owner_grants_probe>).

### `unauthenticated_401_is_cache_suppressed`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/cache_suppression.rs unauthenticated_401_is_cache_suppressed}}

Relies on [`cache_suppress`](<../HTTP/Middleware Explanation.md#item-cache_suppress>), outside [`require_valid_session`](<../HTTP/Middleware Explanation.md#item-require_valid_session>).

### `unknown_device_404_is_cache_suppressed`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/cache_suppression.rs unknown_device_404_is_cache_suppressed}}

Relies on [`cache_suppress`](<../HTTP/Middleware Explanation.md#item-cache_suppress>).

### `pending_authorization_status_is_cache_suppressed`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/cache_suppression.rs pending_authorization_status_is_cache_suppressed}}

This is an `/oauth` route, so the handler wraps its own response. Relies on [`CacheSuppressed`](<../HTTP/Errors and Wire Shapes Explanation.md#item-CacheSuppressed>). Fixtures first used here: [`get_authorization_status`](<Test Fixtures Explanation.md#item-get_authorization_status>).
