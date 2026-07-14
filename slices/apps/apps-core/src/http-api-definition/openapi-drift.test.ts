/**
 * Spec-drift contract test — the apps catalogue surface.
 *
 * Diffs the Rust/axum server's OpenAPI spec (emitted by `utoipa`, committed at
 * `apps-rust/openapi/apps.openapi.json`) against the TypeScript clients' specs
 * (`OpenApi.fromApi(AppsApi)` for the public surface, `OpenApi.fromApi(AppsAdminApi)`
 * for the admin one). The generic wire-shape comparison + the parse/dereference/assert
 * harness live in `shared-structures-core/openapi-drift`;this file owns only the
 * apps-specific scope and accepted differences.
 *
 * Regenerate the committed server spec after a wire-type change with:
 *   UPDATE_OPENAPI=1 cargo test -p apps-rust openapi_spec_snapshot_is_up_to_date
 */

import { OpenApi } from '@effect/platform'
import { defineSpecDriftTest } from 'shared-structures-core/openapi-drift/testing'
import { describe, expect, test } from 'vite-plus/test'

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
    ['/apps/{id}', 'get'],
  ],
  /**
   * `post`/`get /apps/{id}` (LaunchApp / LaunchAppGet) are launches: the server
   * answers a 302 (web) or 204 (Tauri host sink) with no JSON body. The TS side
   * declares those two empty success statuses (so the loopback typed client
   * decodes them — see the focused test below) but deliberately omits the
   * server's `401`/`503` error bodies, which the client never models. Their path
   * parameter is still compared; their responses are not. (`get /apps/{id}` is
   * the native-anchor web arm — modelled for spec symmetry but never called by a
   * typed client; the browser follows its `302` directly.)
   */
  responsesNotCompared: new Set<string>(['post /apps/{id}', 'get /apps/{id}']),
})

describe('LaunchApp success statuses', () => {
  // The loopback launch arm drives `POST /apps/{id}` through the typed client, so
  // the empty success statuses the host returns — `204` (host sink opened the
  // popup) and `302` (redirect) — must be *declared* as accepted. If `204` isn't,
  // it matches no declared status and the client rejects, logging a spurious
  // failure on every successful loopback launch. This pins the declaration so a
  // future edit can't silently drop it.
  test('declares 204 and 302 so the loopback typed client decodes them as success', () => {
    const spec = OpenApi.fromApi(AppsApi)
    const responses = spec.paths['/apps/{id}']?.post?.responses ?? {}
    expect(Object.keys(responses)).toEqual(expect.arrayContaining(['204', '302']))
  })
})

defineSpecDriftTest({
  name: 'apps catalogue (admin)',
  serverSpec,
  clientApi: AppsAdminApi,
  /** Endpoints compared — `(path, lowercase method)`. Per-kind detail/create/
   * replace on their own root resources, the unified delete, and home-screen. */
  scope: [
    ['/cloud-apps', 'post'],
    ['/cloud-apps/{id}', 'get'],
    ['/cloud-apps/{id}', 'put'],
    ['/self-hosted-apps', 'post'],
    ['/self-hosted-apps/{id}', 'get'],
    ['/self-hosted-apps/{id}', 'put'],
    ['/system-apps/{id}', 'get'],
    ['/apps/{id}', 'delete'],
    ['/home-screen', 'put'],
  ],
})

describe('CreateSelfHostedApp request body', () => {
  // `POST /self-hosted-apps` is the upload route: a `multipart/form-data` form
  // carrying the self-hosted `bundle` as a file part. Pin the client-side wire
  // contract so a future edit can't silently swap it back to JSON (which would
  // break the upload) or drop the file part.
  test('is a multipart/form-data body with a binary bundle field', () => {
    const spec = OpenApi.fromApi(AppsAdminApi)
    const content = spec.paths['/self-hosted-apps']?.post?.requestBody?.content ?? {}
    expect(Object.keys(content)).toEqual(['multipart/form-data'])
    // `bundle` is the uploaded file part — Effect renders it as a `$ref` to the
    // `PersistedFile` component (which dereferences to a binary string).
    expect(Object.values(content)[0]?.schema).toMatchObject({
      type: 'object',
      properties: { bundle: { $ref: '#/components/schemas/PersistedFile' } },
    })
  })
})
