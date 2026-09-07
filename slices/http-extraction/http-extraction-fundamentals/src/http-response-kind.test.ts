import { Effect, Option } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor, utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import * as HttpResponseKind from './http-response-kind.ts'
import type * as HttpResponse from './http-response.ts'
import { makeHttpResponse, SimpleResponseKind } from './test-helpers.ts'

const { expectRightToEqual, expectLeftToEqual } = utilityExpectations(expect)

const makeResponse = (body: string): HttpResponse.HttpResponse =>
  makeHttpResponse({ headers: [['content-type', 'text']], body })

/**
 * `parse` returns an `Effect<readonly TParsed[], ParseError>`. The
 * tests run it via `Effect.runSync(Effect.either(...))` so the
 * existing `expectRight/LeftToEqual` helpers — keyed on the
 * `Either` tag — still apply.
 */
describe('HttpResponseKind.make', () => {
  it('parses valid JSON into a resource array', () => {
    expectRightToEqual(
      Effect.runSync(
        Effect.either(
          SimpleResponseKind.parse(makeResponse(JSON.stringify({ name: 'Alice', age: 30 })))
        )
      ),
      [{ name: 'Alice', age: 30 }]
    )
  })

  it('fails with ParseError for malformed JSON', () => {
    expectLeftToEqual(
      Effect.runSync(Effect.either(SimpleResponseKind.parse(makeResponse('{ not valid json }')))),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })

  it('fails with ParseError when JSON does not match the schema', () => {
    expectLeftToEqual(
      Effect.runSync(
        Effect.either(
          SimpleResponseKind.parse(
            makeResponse(JSON.stringify({ name: 'Alice', age: 'not-a-number' }))
          )
        )
      ),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })

  it('fails with ParseError for JSON with missing required fields', () => {
    expectLeftToEqual(
      Effect.runSync(
        Effect.either(SimpleResponseKind.parse(makeResponse(JSON.stringify({ name: 'Alice' }))))
      ),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })

  it('never throws on arbitrary JSON strings', () => {
    fc.assert(
      fc.property(fc.json(), (json) => {
        const result = Effect.runSync(Effect.either(SimpleResponseKind.parse(makeResponse(json))))
        expect(['Right', 'Left']).toContain(result._tag)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('clones only the known fields, dropping an unexpected one', () => {
    // A non-literal carrying an extra property: `make` copies only the known
    // fields, so `surprise` is silently dropped (excess-property check does not
    // fire on a pre-built value).
    const definition = {
      name: 'ExtraFieldKind',
      tryRecognize: (url: string) =>
        url.endsWith('/keep') ? Option.some({ specificity: 10 }) : Option.none(),
      parse: () => Effect.succeed([]),
      surprise: 'dropped',
    }
    const made = HttpResponseKind.make(definition)

    expect(Object.hasOwn(made, 'surprise')).toBe(false)
    expect(Option.isSome(made.tryRecognize('https://x/keep', Option.none()))).toBe(true)
    expect(Option.isNone(made.tryRecognize('https://x/drop', Option.none()))).toBe(true)
    expect(Object.isFrozen(made)).toBe(true)
  })
})
