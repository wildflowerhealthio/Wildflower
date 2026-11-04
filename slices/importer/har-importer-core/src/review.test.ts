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
    const [previewed] = Effect.runSync(preview([kind], [response], new Set(['Text'])))

    expect(previewed?.outcome).toEqual({
      _tag: 'resources',
      resources: [{ key: 'req-0:0', resource: 'body' }],
    })
    expect(previewed?.pickKindName).toEqual(Option.some('Text'))
  })
})
