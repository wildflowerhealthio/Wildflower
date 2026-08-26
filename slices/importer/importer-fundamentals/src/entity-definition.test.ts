import { Effect } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor, utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import type * as ImportableResponse from './importable-response.ts'
import { makeImportableResponse, SimpleEntity } from './test-helpers.ts'

const { expectRightToEqual, expectLeftToEqual } = utilityExpectations(expect)

const makeResponse = (body: string): ImportableResponse.ImportableResponse =>
  makeImportableResponse({ headers: [['content-type', 'text']], body })

/**
 * `parse` returns an `Effect<readonly TResources[], ParseError>`. The
 * tests run it via `Effect.runSync(Effect.either(...))` so the
 * existing `expectRight/LeftToEqual` helpers — keyed on the
 * `Either` tag — still apply.
 */
describe('EntityDefinition.make', () => {
  it('parses valid JSON into a resource array', () => {
    expectRightToEqual(
      Effect.runSync(
        Effect.either(SimpleEntity.parse(makeResponse(JSON.stringify({ name: 'Alice', age: 30 }))))
      ),
      [{ name: 'Alice', age: 30 }]
    )
  })

  it('fails with ParseError for malformed JSON', () => {
    expectLeftToEqual(
      Effect.runSync(Effect.either(SimpleEntity.parse(makeResponse('{ not valid json }')))),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })

  it('fails with ParseError when JSON does not match the schema', () => {
    expectLeftToEqual(
      Effect.runSync(
        Effect.either(
          SimpleEntity.parse(makeResponse(JSON.stringify({ name: 'Alice', age: 'not-a-number' })))
        )
      ),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })

  it('fails with ParseError for JSON with missing required fields', () => {
    expectLeftToEqual(
      Effect.runSync(
        Effect.either(SimpleEntity.parse(makeResponse(JSON.stringify({ name: 'Alice' }))))
      ),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })

  it('never throws on arbitrary JSON strings', () => {
    fc.assert(
      fc.property(fc.json(), (json) => {
        const result = Effect.runSync(Effect.either(SimpleEntity.parse(makeResponse(json))))
        expect(['Right', 'Left']).toContain(result._tag)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
