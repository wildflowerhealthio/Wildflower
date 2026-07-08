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
  ],
  /**
   * `post /apps/{id}` (LaunchApp) is a launch: the server answers a 302 (web) or
   * 204 (Tauri host sink) with no JSON body. The TS side declares those two
   * empty success statuses (so the loopback typed client decodes them — see the
   * focused test below) but deliberately omits the server's `401`/`503` error
   * bodies, which the client never models. Its path parameter is still compared;
   * its responses are not.
   */
  responsesNotCompared: new Set<string>(['post /apps/{id}']),
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
  /** Endpoints compared — `(path, lowercase method)`. */
  scope: [
    ['/apps', 'post'],
    ['/apps/{id}', 'put'],
    ['/apps/{id}', 'delete'],
    ['/self-hosted-apps', 'post'],
    ['/home-screen', 'put'],
  ],
  /**
   * `post /self-hosted-apps` (CreateSelfHostedApp) uploads a raw zip. utoipa
   * renders the Rust `Vec<u8>` body as `{type:'array',items:{type:'integer'}}`,
   * while Effect's `withEncoding({ kind: 'Uint8Array' })` emits
   * `{type:'string',format:'binary'}` — the two normalize to different wire
   * shapes (`integer[]` vs `string`) that can never compare equal, though both
   * describe the same raw bytes on the wire. Its `name` query param and its
   * `200`/`400` responses are still compared; the request body is pinned by the
   * focused test below instead.
   */
  requestsNotCompared: new Set<string>(['post /self-hosted-apps']),
})

describe('CreateSelfHostedApp request body', () => {
  // The drift guard skips this operation's request body (utoipa's `Vec<u8>`
  // can't normalize equal to Effect's binary encoding — see the scope above),
  // so pin the client-side shape directly: the body must stay a raw
  // `application/zip` Uint8Array upload. This guards against a future edit
  // silently swapping it to JSON (which the loopback client would then send
  // with the wrong content type, and the Rust `Bytes` reader would reject).
  test('is a raw application/zip binary body, not JSON', () => {
    const spec = OpenApi.fromApi(AppsAdminApi)
    const content = spec.paths['/self-hosted-apps']?.post?.requestBody?.content ?? {}
    // `application/zip` isn't in Effect's typed content-type union, so read the
    // sole media type positionally rather than by literal key.
    expect(Object.keys(content)).toEqual(['application/zip'])
    expect(Object.values(content)[0]?.schema).toMatchObject({ type: 'string', format: 'binary' })
  })
})
