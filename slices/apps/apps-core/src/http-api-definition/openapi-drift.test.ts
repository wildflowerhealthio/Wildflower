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

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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
   * `post /apps/{id}` (LaunchApp) declares the two successes the client decodes
   * (see the focused test below) but deliberately omits the server's `503`
   * error body, which the client never models. Its path parameter is still
   * compared; its responses are not.
   */
  responsesNotCompared: new Set<string>(['post /apps/{id}']),
})

describe('LaunchApp success statuses', () => {
  // Every owner UI drives `POST /apps/{id}` through the typed client, so both
  // success statuses the host returns — `204` (host sink opened the popup) and
  // `200` (the URL for a forwarded caller to navigate to) — must be *declared*.
  // An undeclared one matches no success and the client rejects, reporting a
  // failed launch for one that worked. The server's own statuses are read from
  // its committed spec, so a status added on either side alone fails here.
  test('declares exactly the success statuses the server answers', () => {
    const spec = OpenApi.fromApi(AppsApi)
    const clientStatuses = Object.keys(spec.paths['/apps/{id}']?.post?.responses ?? {}).filter(
      (status) => status.startsWith('2')
    )
    const serverStatuses = Object.keys(
      serverLaunchResponses(JSON.parse(readFileSync(fileURLToPath(serverSpec), 'utf8')))
    ).filter((status) => status.startsWith('2'))
    expect(clientStatuses.toSorted()).toEqual(serverStatuses.toSorted())
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

// Helpers

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The `responses` object of `POST /apps/{id}` in a parsed server spec. */
const serverLaunchResponses = (spec: unknown): Record<string, unknown> => {
  const paths = isRecord(spec) ? spec['paths'] : undefined
  const path = isRecord(paths) ? paths['/apps/{id}'] : undefined
  const post = isRecord(path) ? path['post'] : undefined
  const responses = isRecord(post) ? post['responses'] : undefined
  return isRecord(responses) ? responses : {}
}
