import { Schema } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import { Patient } from '../src/livestore/index.ts'
import { Bundle } from '../src/schemas/index.ts'
import { makePatient } from './fixtures.ts'

describe('Bundle entry round-trip through Bundle.Schema(Patient.RowSchema)', () => {
  test('encoded transaction-bundle entry decodes back to the same patient', () => {
    const BundleOfPatient = Bundle.Schema(Patient.RowSchema)
    const decoded: typeof BundleOfPatient.Type = BundleOfPatient.make({
      resourceType: 'Bundle',
      id: 'b1',
      meta: null,
      implicitRules: null,
      language: null,
      type: 'transaction',
      identifier: null,
      link: [],
      signature: null,
      timestamp: null,
      total: 1,
      entry: [
        {
          id: null,
          extension: [],
          modifierExtension: [],
          fullUrl: new URL('http://example.org/Patient/p1'),
          link: [],
          resource: makePatient({ id: 'p1', gender: 'female' }),
          request: {
            id: null,
            extension: [],
            modifierExtension: [],
            method: 'POST',
            url: 'Patient',
            ifNoneMatch: null,
            ifModifiedSince: null,
            ifMatch: null,
            ifNoneExist: null,
          },
          response: null,
          search: null,
        },
      ],
    })

    const encoded = Schema.encodeSync(BundleOfPatient)(decoded)
    const reDecoded = Schema.decodeSync(BundleOfPatient)(encoded)

    expect(reDecoded.entry).toHaveLength(1)
    expect(reDecoded.entry[0]?.resource?.id).toBe('p1')
    expect(reDecoded.entry[0]?.resource?.gender).toBe('female')
    expect(reDecoded.entry[0]?.request?.method).toBe('POST')
    expect(reDecoded.entry[0]?.fullUrl?.toString()).toBe('http://example.org/Patient/p1')
  })
})
