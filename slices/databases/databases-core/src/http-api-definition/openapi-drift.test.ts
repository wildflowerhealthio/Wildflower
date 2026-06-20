/**
 * Spec-drift contract test — the data-management (`/databases`) surface.
 *
 * Diffs the Rust/axum server's OpenAPI spec (emitted by `utoipa`, committed at
 * `databases-rust/openapi/databases.openapi.json`) against the TypeScript
 * client's spec (`OpenApi.fromApi(DatabasesApi)`). The generic wire-shape
 * comparison + the parse/dereference/assert harness live in
 * `shared-structures-core/openapi-drift`; this file owns only the
 * databases-specific scope.
 *
 * The export endpoint (`GET /databases/{id}`) is intentionally out of scope: its
 * body is a raw SQLite stream, so it's documented on the server (utoipa) only
 * and consumed via the raw `HttpClient`, never the Effect JSON client. The
 * stale-scope guard ignores it because it's absent from the client spec.
 *
 * Regenerate the committed server spec after a wire-type change with:
 *   UPDATE_OPENAPI=1 cargo test -p databases-rust openapi_spec_snapshot_is_up_to_date
 */

import { defineSpecDriftTest } from 'shared-structures-core/openapi-drift/testing'
import { DatabasesApi } from './index.ts'

defineSpecDriftTest({
  name: 'databases',
  serverSpec: new URL('../../../databases-rust/openapi/databases.openapi.json', import.meta.url),
  clientApi: DatabasesApi,
  /** Endpoints compared — `(path, lowercase method)`. */
  scope: [
    ['/databases', 'get'],
    ['/databases/{id}', 'delete'],
  ],
})
