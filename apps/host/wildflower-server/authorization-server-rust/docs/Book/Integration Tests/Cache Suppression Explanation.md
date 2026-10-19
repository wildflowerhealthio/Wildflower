# Cache Suppression

{{#covers apps/host/wildflower-server/authorization-server-rust/tests/integration/cache_suppression.rs}}

Consent prompts, device prompts and the grants list are the Owner's private data. **No browser or shared cache may keep them: every response carries `Cache-Control: no-store` and `Pragma: no-cache`, once each.** On `/authorization` one layer, {{#code-link apps/host/wildflower-server/authorization-server-rust/src/http/middleware/cache_suppression.rs cache_suppress}}, wraps every response, so handler output, the session gate's `401` and a handler's `404` all carry the headers. The `/oauth` handlers wrap their own responses in the same {{#code-link apps/host/wildflower-server/authorization-server-rust/src/http/wire_representations.rs CacheSuppressed}}.

Each test checks a response with [assert_cache_suppressed](<../Integration Tests Explanation.md#assert_cache_suppressed>).

## Helpers

A `GET` as the Owner:

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/cache_suppression.rs owner_get}}

## `device_prompt_is_cache_suppressed`

**The Owner's device prompt is uncached.**

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/cache_suppression.rs device_prompt_is_cache_suppressed}}

## `oauth_consent_prompt_is_cache_suppressed`

**The Owner's consent prompt for an app's request is uncached.**

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/cache_suppression.rs oauth_consent_prompt_is_cache_suppressed}}

## `grants_list_is_cache_suppressed`

**The grants list is uncached.**

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/cache_suppression.rs grants_list_is_cache_suppressed}}

## `unauthenticated_401_is_cache_suppressed`

**The session gate's `401` is uncached too**: the gate sits inside the layer.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/cache_suppression.rs unauthenticated_401_is_cache_suppressed}}

## `unknown_device_404_is_cache_suppressed`

**A handler's own `404` is uncached like its `200`.**

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/cache_suppression.rs unknown_device_404_is_cache_suppressed}}

## `pending_authorization_status_is_cache_suppressed`

**The wait page's status poll is uncached while the request is pending.** This is an `/oauth` route, so the handler wraps its own response.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/cache_suppression.rs pending_authorization_status_is_cache_suppressed}}

The status is read with [get_authorization_status](<../Integration Tests Explanation.md#get_authorization_status>).
