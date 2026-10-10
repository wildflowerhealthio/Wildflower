/**
 * Spec-drift contract test — the request log (`/requests`, `/requests/callers`)
 * surface.
 *
 * Diffs the Rust/axum server's OpenAPI spec (emitted by `utoipa`, committed at
 * `request-log-rust/openapi/request-log.openapi.json`) against the TypeScript
 * client's spec (`OpenApi.fromApi(RequestLogApi)`). The generic wire-shape
 * comparison + the parse/dereference/assert harness live in
 * `shared-structures-core/openapi-drift`; this file owns only the
 * request-log-specific scope.
 *
 * Regenerate the committed server spec after a wire-type change with:
 *   UPDATE_OPENAPI=1 cargo test -p request-log-rust openapi_spec_snapshot_is_up_to_date
 */

import { defineSpecDriftTest } from 'shared-structures-core/openapi-drift/testing'
import { RequestLogApi } from './index.ts'

defineSpecDriftTest({
  name: 'request log',
  serverSpec: new URL(
    '../../../../../host/wildflower-server/request-log-rust/openapi/request-log.openapi.json',
    import.meta.url
  ),
  clientApi: RequestLogApi,
  /** Endpoints compared — `(path, lowercase method)`. */
  scope: [
    ['/requests/callers', 'get'],
    ['/requests', 'get'],
  ],
})
