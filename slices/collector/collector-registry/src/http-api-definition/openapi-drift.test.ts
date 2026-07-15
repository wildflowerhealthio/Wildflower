/**
 * Spec-drift contract test — the collector remotes surface.
 *
 * Diffs the Rust/axum server's OpenAPI spec (emitted by `utoipa`, committed at
 * `collector-rust/openapi/collector.openapi.json`) against the TypeScript
 * client's spec (`OpenApi.fromApi(CollectorApi)`). The generic wire-shape
 * comparison + the parse/dereference/assert harness live in
 * `shared-structures-core/openapi-drift`; this file owns only the
 * collector-specific scope.
 *
 * The `config` field is deliberately a wildcard on the server side: the
 * per-collector `CollectorConfig` union is TS-owned and opaque to Rust (stored
 * and served verbatim), so the Rust spec declares it as an unconstrained
 * value and the engine treats it as matching any client shape.
 *
 * Regenerate the committed server spec after a wire-type change with:
 *   UPDATE_OPENAPI=1 cargo test -p collector-rust openapi_spec_snapshot_is_up_to_date
 */

import { defineSpecDriftTest } from 'shared-structures-core/openapi-drift/testing'

import { CollectorApi } from './index.ts'

const serverSpec = new URL(
  '../../../collector-rust/openapi/collector.openapi.json',
  import.meta.url
)

defineSpecDriftTest({
  name: 'collector remotes',
  serverSpec,
  clientApi: CollectorApi,
  /** Endpoints compared — `(path, lowercase method)`. */
  scope: [
    ['/collector/remotes', 'get'],
    ['/collector/remotes', 'post'],
    ['/collector/remotes/{id}', 'get'],
    ['/collector/remotes/{id}', 'put'],
    ['/collector/remotes/{id}', 'delete'],
  ],
})
