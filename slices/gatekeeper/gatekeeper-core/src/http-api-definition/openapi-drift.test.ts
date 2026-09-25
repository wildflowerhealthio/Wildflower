/**
 * Spec-drift contract test — gatekeeper OAuth + discovery surface, plus the
 * documented slice of `/access` (client management).
 *
 * Diffs the Rust/axum server's OpenAPI spec (emitted by `utoipa`, committed at
 * `gatekeeper-rust/openapi/gatekeeper-oauth.openapi.json`) against the TypeScript
 * client's spec (`OpenApi.fromApi(GatekeeperApi)`). The generic wire-shape
 * comparison + the parse/dereference/assert harness live in
 * `shared-structures-core/openapi-drift`; this file owns only the
 * gatekeeper-specific scope and accepted differences.
 *
 * Regenerate the committed server spec after a wire-type change with:
 *   UPDATE_OPENAPI=1 cargo test -p gatekeeper-rust openapi_spec_snapshot_is_up_to_date
 */

import { defineSpecDriftTest } from 'shared-structures-core/openapi-drift/testing'
import { GatekeeperApi } from './index.ts'

defineSpecDriftTest({
  name: 'gatekeeper OAuth',
  serverSpec: new URL(
    '../../../gatekeeper-rust/openapi/gatekeeper-oauth.openapi.json',
    import.meta.url
  ),
  clientApi: GatekeeperApi,
  /** Endpoints compared — `(path, lowercase method)`. */
  scope: [
    ['/.well-known/jwks.json', 'get'],
    ['/oauth/authorize', 'get'],
    ['/oauth/authorize/{id}', 'get'],
    ['/oauth/token', 'post'],
    ['/oauth/device_authorization', 'post'],
    ['/access/clients', 'get'],
    ['/access/clients/{clientId}', 'patch'],
  ],
  /**
   * `get /oauth/authorize` is a browser front door: success is a 302 redirect and
   * errors are HTML pages, not a JSON contract (the TS side models it loosely as
   * `200 text/html`). Its request parameters are still compared; its responses
   * are not. The OAuth `error` codes and the opaque JWKS key object need no
   * exception — the engine handles them structurally (string-narrowing and
   * `unknown`-wildcard).
   */
  responsesNotCompared: new Set<string>(['get /oauth/authorize']),
})
