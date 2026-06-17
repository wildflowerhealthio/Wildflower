/**
 * Spec-drift contract test (trial: gatekeeper OAuth + discovery surface).
 *
 * Diffs the Rust/axum server's OpenAPI spec (emitted by `utoipa`, committed at
 * `gatekeeper-rust/openapi/gatekeeper-oauth.openapi.json`) against the TypeScript
 * client's spec (`OpenApi.fromApi(GatekeeperApi)`). The generic wire-shape
 * comparison lives in `shared-structures-core/openapi-drift`; this file owns the
 * gatekeeper-specific scope, accepted differences, and the dereference step.
 *
 * Regenerate the committed server spec after a wire-type change with:
 *   UPDATE_OPENAPI=1 cargo test -p gatekeeper-rust openapi_spec_snapshot_is_up_to_date
 */

import * as fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import $RefParser from '@apidevtools/json-schema-ref-parser'
import { OpenApi } from '@effect/platform'
import { collectSpecDrift, type OpenApiDoc } from 'shared-structures-core/openapi-drift'
import { expect, test } from 'vite-plus/test'
import { GatekeeperApi } from './index.ts'

/** Endpoints compared — `(path, lowercase method)`. */
const SCOPE = [
  ['/.well-known/jwks.json', 'get'],
  ['/oauth/authorize', 'get'],
  ['/oauth/authorize/{id}', 'get'],
  ['/oauth/token', 'post'],
  ['/oauth/device_authorization', 'post'],
] as const

/**
 * `get /oauth/authorize` is a browser front door: success is a 302 redirect and
 * errors are HTML pages, not a JSON contract (the TS side models it loosely as
 * `200 text/html`). Its request parameters are still compared; its responses are
 * not. The OAuth `error` codes and the opaque JWKS key object need no exception —
 * the engine handles them structurally (string-narrowing and `unknown`-wildcard).
 */
const RESPONSES_NOT_COMPARED = new Set<string>(['get /oauth/authorize'])

test('gatekeeper OAuth client (Effect HttpApi) matches the axum OpenAPI spec', async () => {
  // Both specs are external JSON, parsed at this typed boundary into the loose
  // `OpenApiDoc` shape and never trusted beyond it (test-only).
  // oxlint-disable-next-line typescript/no-unsafe-assignment
  const client: OpenApiDoc = JSON.parse(JSON.stringify(OpenApi.fromApi(GatekeeperApi)))
  const serverPath = fileURLToPath(
    new URL('../../../gatekeeper-rust/openapi/gatekeeper-oauth.openapi.json', import.meta.url)
  )
  // oxlint-disable-next-line typescript/no-unsafe-assignment
  const server: OpenApiDoc = JSON.parse(fs.readFileSync(serverPath, 'utf8'))

  // Resolve internal `$ref`s in place (delegated to a battle-tested resolver) so
  // the comparison only sees inlined schemas.
  await $RefParser.dereference(client)
  await $RefParser.dereference(server)

  const drift = collectSpecDrift(server, client, {
    scope: SCOPE,
    responsesNotCompared: RESPONSES_NOT_COMPARED,
  })

  expect(
    drift,
    `Gatekeeper OAuth spec drift between the axum server (source of truth) and the ` +
      `Effect HttpApi client.\nFix the TS HttpApi in oauth.ts / jwks.ts (or, if the ` +
      `server changed, regenerate the committed spec). Differences:\n  - ${drift.join('\n  - ')}`
  ).toEqual([])
})
