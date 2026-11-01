/**
 * Spec-drift contract test — the authorization server OAuth + discovery surface, plus
 * the `/authorization` admin surface.
 *
 * Diffs the Rust/axum server's OpenAPI spec (emitted by `utoipa`, committed at
 * `authorization-server-rust/openapi/authorization-server-oauth.openapi.json`) against the TypeScript
 * client's spec (`OpenApi.fromApi(AuthorizationServerApi)`). The generic wire-shape
 * comparison + the parse/dereference/assert harness live in
 * `shared-structures-core/openapi-drift`; this file owns only the
 * authorization-server-specific scope and accepted differences.
 *
 * Regenerate the committed server spec after a wire-type change with:
 *   UPDATE_OPENAPI=1 cargo test -p wildflowerhealthio-authorization-server openapi_spec_snapshot_is_up_to_date
 */

import { defineSpecDriftTest } from '@wildflowerhealthio/shared-structures-core/openapi-drift/testing'
import { AuthorizationServerApi } from './index.ts'

defineSpecDriftTest({
  name: 'authorization server OAuth',
  serverSpec: new URL(
    '../../../../../apps/host/wildflower-server/authorization-server-rust/openapi/authorization-server-oauth.openapi.json',
    import.meta.url
  ),
  clientApi: AuthorizationServerApi,
  /** Endpoints compared — `(path, lowercase method)`. */
  scope: [
    ['/.well-known/jwks.json', 'get'],
    ['/oauth/authorize', 'get'],
    ['/oauth/authorize/{id}', 'get'],
    ['/oauth/authorize/{id}/session-shortfall', 'get'],
    ['/oauth/authorize/{id}/continue', 'post'],
    ['/oauth/authorize/{id}/cancel', 'post'],
    ['/oauth/authorize/{id}/ask-to-widen', 'post'],
    ['/oauth/session-widenings/{id}/poll', 'post'],
    ['/oauth/token', 'post'],
    ['/oauth/device_authorization', 'post'],
    ['/oauth/pair/start', 'post'],
    ['/oauth/pair/poll', 'post'],
    ['/authorization/browser-sessions', 'get'],
    ['/authorization/browser-sessions/{sid}', 'delete'],
    ['/authorization/clients', 'get'],
    ['/authorization/clients/{clientId}', 'patch'],
    ['/authorization/devices/{userCode}', 'get'],
    ['/authorization/devices/{userCode}/approve', 'post'],
    ['/authorization/devices/{userCode}/deny', 'post'],
    ['/authorization/grants', 'get'],
    ['/authorization/grants/{id}', 'get'],
    ['/authorization/grants/{id}', 'delete'],
    ['/authorization/oauth-consents/{id}', 'get'],
    ['/authorization/oauth-consents/{id}/approve', 'post'],
    ['/authorization/oauth-consents/{id}/ask-owner', 'post'],
    ['/authorization/oauth-consents/{id}/deny', 'post'],
    ['/authorization/revocations', 'post'],
    ['/authorization/session', 'get'],
    ['/authorization/session-widenings/{id}', 'get'],
    ['/authorization/session-widenings/{id}/approve', 'post'],
    ['/authorization/session-widenings/{id}/deny', 'post'],
  ],
  /**
   * `get /oauth/authorize` is a browser front door: success is a 302 redirect and
   * errors are HTML pages, not a JSON contract (the TS side models it loosely as
   * `200 text/html`). Its request parameters are still compared; its responses
   * are not. The OAuth `error` codes and the opaque JWKS key object need no
   * exception — the engine handles them structurally (string-narrowing and
   * `unknown`-wildcard).
   *
   * Two `/authorization` routes' responses are left out for what the client
   * models beyond the wire: the consent card's approve and deny results carry
   * a client-only `error` member, which the card fills in itself when the
   * request has expired; and the `access-management` group declares its
   * insufficient-scope `403` once for every endpoint, the ungated session read
   * included.
   */
  responsesNotCompared: new Set<string>([
    'get /oauth/authorize',
    'post /authorization/oauth-consents/{id}/approve',
    'post /authorization/oauth-consents/{id}/deny',
    'get /authorization/session',
  ]),
})
