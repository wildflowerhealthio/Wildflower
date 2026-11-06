import {
  HttpResponseKind,
  type RecognizedUrlData,
  Specificity,
} from '@wildflowerhealthio/http-extraction-fundamentals'
import { makeExtractionInput } from '@wildflowerhealthio/http-extraction-fundamentals/test-helpers'
import { Effect, Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { preview } from './review.ts'

/**
 * Covers the preview's own folding: each picked response parsed through its
 * kind, its records keyed by the response and their index, as the kind
 * parsed them.
 */

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

const response = makeExtractionInput({ id: 'req-0', url: 'https://example.org/a', body: 'body' })

describe('preview', () => {
  it('keeps every record its kind parsed, keyed by the response and its index', () => {
    const kind = kindRecognizing('Text', { specificity: Specificity.PORTAL })
    const [previewed] = Effect.runSync(preview([kind], [response]))

    expect(previewed?.outcome).toEqual({
      _tag: 'resources',
      resources: [{ key: 'req-0:0', resource: 'body' }],
    })
    expect(previewed?.pickKindName).toEqual(Option.some('Text'))
  })

  it('routes a response to its top-specificity kind, whatever the pool order', () => {
    const protocol = kindRecognizing('Protocol', { specificity: Specificity.PROTOCOL })
    const portal = kindRecognizing('Portal', { specificity: Specificity.PORTAL })
    const [previewed] = Effect.runSync(preview([protocol, portal], [response]))

    expect(previewed?.pickKindName).toEqual(Option.some('Portal'))
  })

  it('notes a response no kind claims as no pick', () => {
    const [previewed] = Effect.runSync(preview([], [response]))

    expect(previewed).toEqual({
      ref: { id: 'req-0', url: 'https://example.org/a' },
      pickKindName: Option.none(),
      outcome: { _tag: 'noPick' },
    })
  })
})
