/**
 * OpenAPI snapshot freshness — the FHIR R4 surface as this client uses it.
 *
 * Unlike the other slices' `openapi-drift` tests, the direction is inverted:
 * there is no `utoipa` spec to diff against, because the server is the
 * off-the-shelf HFS router embedded by `emr-rust` (see the emr slice
 * AGENTS.md). Instead, the Effect `HttpApi` here is the source, and the
 * committed snapshot at `emr-rust/openapi/fhir-r4.openapi.json` is its
 * generated projection — "the system how we use it", not a full description of
 * HFS. `emr-rust` embeds that snapshot to publish the FHIR surface on the
 * host's unified `/docs` Scalar page. This test only keeps the committed file
 * in sync with the `HttpApi`; it is NOT a drift guard against HFS itself (that
 * remains hand-synchronized — see `docs/Client Capabilities Reference.md`).
 *
 * Regenerate after an `HttpApi` change with:
 *   UPDATE_OPENAPI=1 vp test --config slices/emr/fhir-r4/vite.config.ts openapi-drift
 */

import * as fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { OpenApi } from '@effect/platform'
import { describe, expect, it } from 'vite-plus/test'
import { FhirResourcesApi } from './index.ts'

const snapshotUrl = new URL('../../../emr-rust/openapi/fhir-r4.openapi.json', import.meta.url)

describe('generateFhirR4OpenApiSpec', () => {
  it('should declare $everything for Patient only', () => {
    // Arrange / Act
    const spec = generateFhirR4OpenApiSpec()

    // Assert
    const everythingPaths = Object.keys(spec.paths).filter((p) => p.endsWith('/$everything'))
    expect(everythingPaths).toEqual(['/fhir-r4/Patient/{id}/$everything'])
  })

  it('should strip the framework-injected decode-error responses and their schemas', () => {
    // Arrange / Act
    const spec = generateFhirR4OpenApiSpec()

    // Assert — no operation advertises Effect's HttpApiDecodeError 400, and the
    // components pruned down to nothing (every schema existed only for that error).
    const json = JSON.stringify(spec)
    expect(json).not.toContain('HttpApiDecodeError')
    expect(spec.components?.schemas ?? {}).toEqual({})
  })

  it('should match the committed snapshot embedded by emr-rust (regenerate with UPDATE_OPENAPI=1)', () => {
    // Arrange
    const spec = generateFhirR4OpenApiSpec()
    const path = fileURLToPath(snapshotUrl)

    if (process.env['UPDATE_OPENAPI'] !== undefined) {
      // Act (regeneration mode) — rewrite the snapshot, then assert it round-trips.
      fs.writeFileSync(path, `${JSON.stringify(spec, null, 2)}\n`)
    }

    // Act
    // External JSON parsed at this typed boundary; compared structurally only.
    const committed: unknown = JSON.parse(fs.readFileSync(path, 'utf8'))

    // Assert
    expect(
      committed,
      'Committed OpenAPI snapshot is stale relative to the FhirResourcesApi HttpApi. ' +
        'Regenerate with: UPDATE_OPENAPI=1 vp test --config slices/emr/fhir-r4/vite.config.ts openapi-drift'
    ).toEqual(spec)
  })
})

// Helpers

interface SpecOperation {
  responses?: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }>
}
interface Spec {
  info: { title: string; version: string; description?: string }
  paths: Record<string, Record<string, SpecOperation>>
  components?: { schemas?: Record<string, unknown> }
}

/**
 * The OpenAPI document for {@link FhirResourcesApi}, as committed/served:
 * `OpenApi.fromApi` output with a stable `info` block, minus the
 * `HttpApiDecodeError` 400s Effect injects on every operation (framework
 * noise, not part of the FHIR contract) and any component schemas that only
 * existed to describe them.
 */
function generateFhirR4OpenApiSpec(): Spec {
  // Round-trip through JSON to drop undefined-valued fields and prototypes —
  // the committed artifact is plain JSON. Parsed back at this typed boundary
  // into the loose `Spec` shape used only for the transforms below.
  // oxlint-disable-next-line typescript/no-unsafe-assignment
  const spec: Spec = JSON.parse(JSON.stringify(OpenApi.fromApi(FhirResourcesApi)))

  spec.info = {
    title: 'FHIR R4 (HFS)',
    // Fixed: the snapshot describes a wire contract, not a release; bumping it
    // per package release would churn the committed file for no consumer.
    version: '0.0.1',
    description:
      'The subset of the embedded HFS FHIR R4 server that the Wildflower client uses — ' +
      'generated from the `fhir-r4` Effect HttpApi, not from the server. ' +
      'See slices/emr/fhir-r4/docs/Client Capabilities Reference.md.',
  }

  for (const operations of Object.values(spec.paths)) {
    for (const operation of Object.values(operations)) {
      const badRequest = operation.responses?.['400']
      const schema = badRequest?.content?.['application/json']?.schema
      if (schema?.$ref === '#/components/schemas/HttpApiDecodeError') {
        delete operation.responses?.['400']
      }
    }
  }
  pruneUnreferencedSchemas(spec)
  return spec
}

/** Repeatedly drop `components.schemas` entries with no `$ref` pointing at them
 * anywhere in the document (transitive: `HttpApiDecodeError` → `Issue` → `PropertyKey`). */
function pruneUnreferencedSchemas(spec: Spec): void {
  const schemas = spec.components?.schemas
  if (schemas === undefined) return
  for (;;) {
    const json = JSON.stringify(spec)
    const dropped = Object.keys(schemas).filter(
      (name) => !json.includes(`"#/components/schemas/${name}"`)
    )
    if (dropped.length === 0) return
    for (const name of dropped) delete schemas[name]
  }
}
