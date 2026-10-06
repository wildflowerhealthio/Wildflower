/**
 * Spec-drift contract test — tunnel admin (`/tunnel`) surface.
 *
 * Diffs the Rust/axum server's OpenAPI spec (emitted by `utoipa`, committed at
 * `tunnel-rust/openapi/tunnel-admin.openapi.json`) against the TypeScript
 * client's spec (`OpenApi.fromApi(TunnelAdminApi)`). The generic wire-shape
 * comparison + the parse/dereference/assert harness live in
 * `shared-structures-core/openapi-drift`; this file owns only the
 * tunnel-specific scope.
 *
 * Regenerate the committed server spec after a wire-type change with:
 *   UPDATE_OPENAPI=1 cargo test -p tunnel-rust openapi_spec_snapshot_is_up_to_date
 */

import { defineSpecDriftTest } from 'shared-structures-core/openapi-drift/testing'
import { TunnelAdminApi } from './index.ts'

defineSpecDriftTest({
  name: 'tunnel admin',
  serverSpec: new URL('../../../tunnel-rust/openapi/tunnel-admin.openapi.json', import.meta.url),
  clientApi: TunnelAdminApi,
  /** Endpoints compared — `(path, lowercase method)`. */
  scope: [
    ['/tunnel', 'get'],
    ['/tunnel', 'put'],
  ],
})
