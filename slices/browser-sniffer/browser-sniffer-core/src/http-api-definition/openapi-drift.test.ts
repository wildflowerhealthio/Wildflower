/**
 * Spec-drift contract test — the `/sniffer` control surface.
 *
 * Diffs the Rust/axum server's OpenAPI spec (emitted by `utoipa`, committed at
 * `browser-sniffer-rust/openapi/browser-sniffer.openapi.json`) against this
 * package's `BrowserSnifferApi` (`OpenApi.fromApi`). The generic wire-shape
 * comparison + harness live in `shared-structures-core/openapi-drift`; this
 * file owns only the sniffer-specific scope.
 *
 * The `/sniffer/events` WebSocket is deliberately outside both specs (OpenAPI
 * has no WS operation shape); its message contract is pinned by the tagged
 * schemas in `../messages.ts` and the Rust tag drift-guard tests.
 *
 * Regenerate the committed server spec after a wire-type change with:
 *   UPDATE_OPENAPI=1 cargo test -p browser-sniffer-rust openapi_spec_snapshot_is_up_to_date
 */

import { defineSpecDriftTest } from 'shared-structures-core/openapi-drift/testing'

import { BrowserSnifferApi } from './index.ts'

const serverSpec = new URL(
  '../../../browser-sniffer-rust/openapi/browser-sniffer.openapi.json',
  import.meta.url
)

defineSpecDriftTest({
  name: 'browser sniffer',
  serverSpec,
  clientApi: BrowserSnifferApi,
  /** Endpoints compared — `(path, lowercase method)`. */
  scope: [
    ['/sniffer/webview', 'post'],
    ['/sniffer/webview', 'delete'],
    ['/sniffer/status', 'put'],
    ['/sniffer/visibility', 'post'],
    ['/sniffer/page-actions', 'post'],
    ['/sniffer/cancellations', 'post'],
  ],
})
