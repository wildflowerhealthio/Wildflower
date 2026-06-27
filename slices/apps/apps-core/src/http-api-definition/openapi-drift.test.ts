/**
 * Spec-drift contract test — the apps catalogue surface.
 *
 * Diffs the Rust/axum server's OpenAPI spec (emitted by `utoipa`, committed at
 * `apps-rust/openapi/apps.openapi.json`) against the TypeScript clients' specs
 * (`OpenApi.fromApi(AppsApi)` for the public surface, `OpenApi.fromApi(
 * AppsAdminApi)` for the admin one). The generic wire-shape comparison + the
 * parse/dereference/assert harness live in `shared-structures-core/openapi-drift`;
 * this file owns only the apps-specific scope and accepted differences.
 *
 * Regenerate the committed server spec after a wire-type change with:
 *   UPDATE_OPENAPI=1 cargo test -p apps-rust openapi_spec_snapshot_is_up_to_date
 */

import { defineSpecDriftTest } from 'shared-structures-core/openapi-drift/testing'
import { AppsAdminApi, AppsApi } from './index.ts'

const serverSpec = new URL('../../../apps-rust/openapi/apps.openapi.json', import.meta.url)

defineSpecDriftTest({
  name: 'apps catalogue (public)',
  serverSpec,
  clientApi: AppsApi,
  /** Endpoints compared — `(path, lowercase method)`. */
  scope: [
    ['/apps', 'get'],
    ['/apps/{id}', 'post'],
  ],
  /**
   * `post /apps/{id}` (LaunchApp) is a launch: the server answers a 302 (web)
   * or 204 (Tauri host sink) with no JSON body, while the TS side models
   * success loosely as `200 text/html`. Its path parameter is still compared;
   * its responses are not.
   */
  responsesNotCompared: new Set<string>(['post /apps/{id}']),
})

defineSpecDriftTest({
  name: 'apps catalogue (admin)',
  serverSpec,
  clientApi: AppsAdminApi,
  /** Endpoints compared — `(path, lowercase method)`. */
  scope: [
    ['/apps', 'post'],
    ['/apps/{id}', 'patch'],
    ['/apps/{id}', 'delete'],
    ['/apps/{id}/placement', 'patch'],
  ],
})
