import { Schema } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import { AccountNewSearch } from './account.new.tsx'

// `validateSearch` on the `/collector/account/new` route is wired as
// `Schema.standardSchemaV1(AccountNewSearch)`. These cases pin the boundary
// behavior of the generic search: a `tag` (defaulted to the first registered
// collector) selects the config form, and an optional loose `prefill` bag seeds
// fields. Well-typed input decodes through; a bad `tag` or a non-record
// `prefill` is rejected with `issues` rather than silently coerced. The
// validator is synchronous for this schema, but the Standard-Schema `validate`
// contract permits a Promise — awaiting the result handles both without
// changing the assertion.
const validate = Schema.standardSchemaV1(AccountNewSearch)['~standard'].validate

describe('account.new validateSearch', () => {
  test('accepts a well-typed tag + prefill search', async () => {
    const result = await validate({
      tag: 'fhir-r4',
      prefill: { name: 'Demo FHIR Server', rootUrl: 'https://example.test/fhir' },
    })
    expect(result.issues).toBeUndefined()
    expect(result).toEqual(
      expect.objectContaining({
        value: {
          tag: 'fhir-r4',
          prefill: { name: 'Demo FHIR Server', rootUrl: 'https://example.test/fhir' },
        },
      })
    )
  })

  test('defaults tag on empty search (prefill omitted)', async () => {
    const result = await validate({})
    expect(result.issues).toBeUndefined()
    expect(result).toEqual(expect.objectContaining({ value: { tag: 'fhir-r4' } }))
  })

  test('rejects an unregistered tag with issues', async () => {
    const result = await validate({ tag: 'not-a-collector' })
    expect(result.issues).toEqual(expect.arrayContaining([expect.anything()]))
  })

  test('rejects a non-record prefill with issues', async () => {
    const result = await validate({ tag: 'fhir-r4', prefill: 'nope' })
    expect(result.issues).toEqual(expect.arrayContaining([expect.anything()]))
  })
})
