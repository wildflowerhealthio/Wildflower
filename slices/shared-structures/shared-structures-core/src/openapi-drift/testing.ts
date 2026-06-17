/**
 * Test-support factory for OpenAPI spec-drift contract tests.
 *
 * A slice's `-core` package registers a one-liner test: it points at its
 * committed server snapshot (the `utoipa`-emitted JSON) and its Effect
 * `HttpApi`, and this wires up the parse → dereference → {@link collectSpecDrift}
 * → assert flow shared by every consumer. Keeping the IO/deref here (Node-only:
 * `node:fs`, `$RefParser`) is why it lives in this `./testing` subpath, separate
 * from the dependency-free pure engine in `./index`.
 *
 * Adding a new project is then: emit a snapshot from the Rust side (see
 * `shared-structures-rust`'s `openapi_snapshot` helper) and call
 * {@link defineSpecDriftTest} with the scope.
 */

import * as fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import $RefParser from '@apidevtools/json-schema-ref-parser'
import { type HttpApi, type HttpApiGroup, OpenApi } from '@effect/platform'
import { expect, test } from 'vite-plus/test'
import { collectSpecDrift, type OpenApiDoc, type SpecDriftOptions } from './index.ts'

// Mirror `OpenApi.fromApi`'s generics so any concrete `HttpApi` is accepted by
// inference — a single materialized supertype (e.g. `HttpApi.HttpApi.Any`) is
// invariant enough that concrete APIs aren't assignable to it.
interface SpecDriftTestConfig<
  Id extends string,
  Groups extends HttpApiGroup.HttpApiGroup.Any,
  E,
  R,
> extends SpecDriftOptions {
  /** Test name — describes the surface under comparison (e.g. `'gatekeeper OAuth'`). */
  readonly name: string
  /**
   * The committed server OpenAPI snapshot (the `utoipa` output), as a file `URL`
   * (typically `new URL('../../../<crate>/openapi/<name>.openapi.json', import.meta.url)`)
   * or an absolute path.
   */
  readonly serverSpec: URL | string
  /** The Effect `HttpApi` whose generated spec is the client side of the diff. */
  readonly clientApi: HttpApi.HttpApi<Id, Groups, E, R>
}

/**
 * Register a spec-drift contract test: the Effect `clientApi`'s generated spec
 * must match the committed `serverSpec` on wire shape, scoped to `scope` (see
 * {@link collectSpecDrift} for the compatibility policy). Both specs are
 * dereferenced before comparison; `$ref` resolution is handled here.
 */
export const defineSpecDriftTest = <
  Id extends string,
  Groups extends HttpApiGroup.HttpApiGroup.Any,
  E,
  R,
>(
  config: SpecDriftTestConfig<Id, Groups, E, R>
): void => {
  const { name, serverSpec, clientApi, ...options } = config

  test(`${name} client (Effect HttpApi) matches the committed OpenAPI spec`, async () => {
    // Both specs are external JSON, parsed at this typed boundary into the loose
    // `OpenApiDoc` shape and never trusted beyond it (test-only).
    // oxlint-disable-next-line typescript/no-unsafe-assignment
    const client: OpenApiDoc = JSON.parse(JSON.stringify(OpenApi.fromApi(clientApi)))
    const serverPath = typeof serverSpec === 'string' ? serverSpec : fileURLToPath(serverSpec)
    // oxlint-disable-next-line typescript/no-unsafe-assignment
    const server: OpenApiDoc = JSON.parse(fs.readFileSync(serverPath, 'utf8'))

    // Resolve internal `$ref`s in place (delegated to a battle-tested resolver)
    // so the comparison only sees inlined schemas.
    await $RefParser.dereference(client)
    await $RefParser.dereference(server)

    const drift = collectSpecDrift(server, client, options)

    expect(
      drift,
      `${name}: OpenAPI spec drift between the server (source of truth) and the ` +
        `Effect HttpApi client.\nFix the TS HttpApi (or, if the server changed, ` +
        `regenerate the committed spec). Differences:\n  - ${drift.join('\n  - ')}`
    ).toEqual([])
  })
}
