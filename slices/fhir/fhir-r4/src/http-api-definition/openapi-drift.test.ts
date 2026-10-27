/**
 * OpenAPI snapshot freshness — the FHIR R4 surface as this client uses it.
 *
 * Unlike the other slices' `openapi-drift` tests, the direction is inverted:
 * there is no `utoipa` spec to diff against, because the server is the
 * off-the-shelf HFS router embedded by `fhir-r4-rust` (see the fhir slice
 * AGENTS.md). Instead, the Effect `HttpApi` here is the source, and the
 * committed snapshot at `fhir-r4/openapi/fhir-r4.openapi.json` is its
 * generated projection — "the system how we use it", not a full description of
 * HFS. The published server-docs console renders that snapshot as the FHIR
 * surface. This test only keeps the committed file
 * in sync with the `HttpApi`; it is NOT a drift guard against HFS itself (that
 * remains hand-synchronized — see `docs/Client Capabilities Reference.md`).
 *
 * Regenerate after an `HttpApi` change with:
 *   UPDATE_OPENAPI=1 vp test --config slices/fhir/fhir-r4/vite.config.ts openapi-drift
 */

import * as fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { OpenApi } from '@effect/platform'
import { describe, expect, it } from 'vite-plus/test'
import { FhirResourcesApi } from './index.ts'

const snapshotUrl = new URL('../../openapi/fhir-r4.openapi.json', import.meta.url)

describe('generateFhirR4OpenApiSpec', () => {
  it('should declare $everything for Patient only', () => {
    // Arrange / Act
    const spec = generateFhirR4OpenApiSpec()

    // Assert
    const everythingPaths = Object.keys(spec.paths).filter((p) => p.endsWith('/$everything'))
    expect(everythingPaths).toEqual(['/Patient/{id}/$everything'])
  })

  it('should strip the framework-injected decode-error responses and their schemas', () => {
    // Arrange / Act
    const spec = generateFhirR4OpenApiSpec()

    // Assert — no operation advertises Effect's HttpApiDecodeError 400, and the
    // schemas that existed only to describe it are pruned. `FhirDateSearch`
    // and `OperationOutcome` survive because the FHIR contract itself names
    // them (the `date` / `birthdate` search parameter value, and a refused
    // Bundle's body); pinning the exact set keeps a stray schema from
    // creeping back.
    const json = JSON.stringify(spec)
    expect(json).not.toContain('HttpApiDecodeError')
    expect(Object.keys(spec.components?.schemas ?? {})).toEqual([
      'FhirDateSearch',
      'OperationOutcome',
    ])
  })

  it('should match the committed snapshot embedded by fhir-r4-rust (regenerate with UPDATE_OPENAPI=1)', () => {
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
        'Regenerate with: UPDATE_OPENAPI=1 vp test --config slices/fhir/fhir-r4/vite.config.ts openapi-drift'
    ).toEqual(spec)
  })
})

// Helpers

interface SpecSchema {
  $ref?: string
  anyOf?: SpecSchema[]
}
interface SpecOperation {
  responses?: Record<
    string,
    { description?: string; content?: Record<string, { schema?: SpecSchema }> }
  >
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
      'See slices/fhir/fhir-r4/docs/Client Capabilities Reference.md.',
  }

  for (const operations of Object.values(spec.paths)) {
    for (const operation of Object.values(operations)) {
      const badRequest = operation.responses?.['400']
      const content = badRequest?.content?.['application/json']
      const schema = content?.schema
      if (schema?.$ref === DECODE_ERROR_REF) {
        delete operation.responses?.['400']
      } else if (content !== undefined && badRequest !== undefined && schema?.anyOf !== undefined) {
        // A 400 the operation declares itself (the Bundle refusal), which
        // Effect merges with its own: keep the declared one alone.
        const declared = schema.anyOf.filter((member) => member.$ref !== DECODE_ERROR_REF)
        content.schema = declared.length === 1 ? declared[0] : { anyOf: declared }
        badRequest.description = 'Error'
      }
    }
  }
  pruneUnreferencedSchemas(spec)
  return spec
}

/** The `$ref` of the decode error Effect adds to every operation's 400. */
const DECODE_ERROR_REF = '#/components/schemas/HttpApiDecodeError'

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
