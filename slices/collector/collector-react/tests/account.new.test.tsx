import { Schema } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import { AccountNewSearch } from '../src/routes/_auth/collector/account.new.tsx'

// `validateSearch` on the `/collector/account/new` route is wired as
// `Schema.standardSchemaV1(AccountNewSearch)`. These cases pin the
// boundary behavior: well-typed prefill search decodes through, while a
// non-string prefill field is rejected with `issues` rather than silently
// coerced. The validator is synchronous for this schema, but the
// Standard-Schema `validate` contract permits a Promise — awaiting the
// result handles both without changing the assertion.
const validate = Schema.standardSchemaV1(AccountNewSearch)['~standard'].validate

describe('account.new validateSearch', () => {
  test('accepts well-typed prefill search', async () => {
    const result = await validate({
      prefillName: 'Demo FHIR Server',
      prefillRootUrl: 'https://example.test/fhir',
      prefillPatientId: 'patient-1',
    })
    expect(result.issues).toBeUndefined()
    expect(result).toEqual(
      expect.objectContaining({
        value: {
          prefillName: 'Demo FHIR Server',
          prefillRootUrl: 'https://example.test/fhir',
          prefillPatientId: 'patient-1',
        },
      })
    )
  })

  test('accepts empty search (all prefill fields optional)', async () => {
    const result = await validate({})
    expect(result.issues).toBeUndefined()
    expect(result).toEqual(expect.objectContaining({ value: {} }))
  })

  test('rejects a non-string prefillName with issues', async () => {
    const result = await validate({ prefillName: 123 })
    expect(result.issues).toEqual(expect.arrayContaining([expect.anything()]))
  })
})
