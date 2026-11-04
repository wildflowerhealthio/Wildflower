import {
  HttpResponseKind,
  type RecognizedUrlData,
  Specificity,
  SystemFamily,
} from '@wildflowerhealthio/http-extraction-fundamentals'
import { makeExtractionInput } from '@wildflowerhealthio/http-extraction-fundamentals/test-helpers'
import { Effect, Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { preview } from './review.ts'

/**
 * Covers the preview's own folding: each picked response parsed and its
 * resources detached under the family its kind recognized it with, and a
 * response whose kind recognized it without one held back as an outcome.
 */

const FAMILY = SystemFamily.FixedAcrossResourceTypes({ system: 'https://example.org/fhir/sid/a' })

/** A kind claiming every URL with `recognized`, parsing every body to its text. */
const kindRecognizing = (
  name: string,
  recognized: RecognizedUrlData
): HttpResponseKind.HttpResponseKind<string> =>
  HttpResponseKind.make({
    name,
    tryRecognize: () => Option.some(recognized),
    parse: (response) => Effect.succeed([response.text()]),
  })

/** Detaches a parsed text by naming the family it was detached under beside it. */
const detachUnder =
  (family: SystemFamily.Type) =>
  (parsed: string): string =>
    `${parsed} under ${SystemFamily.systemFor(family, 'Patient')}`

const response = makeExtractionInput({ id: 'req-0', url: 'https://example.org/a', body: 'body' })

describe('preview', () => {
  it("detaches every resource under the family its kind's recognition minted", () => {
    const kind = kindRecognizing('Keyed', { specificity: Specificity.PORTAL, systemFamily: FAMILY })
    const [previewed] = Effect.runSync(preview([kind], [response], new Set(['Keyed']), detachUnder))

    expect(previewed?.outcome).toEqual({
      _tag: 'resources',
      resources: [{ key: 'req-0:0', resource: 'body under https://example.org/fhir/sid/a' }],
    })
  })

  // Nothing says which namespace the ids it would parse belong to, so the
  // response yields no records rather than records with no key.
  it('holds back a response whose kind recognized it without a family, unparsed', () => {
    let parses = 0
    const kind = HttpResponseKind.make({
      name: 'Unkeyed',
      tryRecognize: () => Option.some({ specificity: Specificity.CATCH_ALL }),
      parse: () => {
        parses += 1
        return Effect.succeed(['never'])
      },
    })
    const [previewed] = Effect.runSync(
      preview([kind], [response], new Set(['Unkeyed']), detachUnder)
    )

    expect(previewed?.outcome).toEqual({ _tag: 'noSystemFamily' })
    expect(previewed?.pickKindName).toEqual(Option.some('Unkeyed'))
    expect(parses).toBe(0)
  })
})
