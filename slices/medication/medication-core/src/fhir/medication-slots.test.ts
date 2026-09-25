import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { containedMedicationOf } from './medication-slots.ts'
import { base, decode } from './test-helpers.ts'

describe('containedMedicationOf', () => {
  it('should pick the contained Medication the #id reference names, else the first', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9-]{0,8}$/), { minLength: 1, maxLength: 4 }),
        fc.nat(),
        fc.boolean(),
        (ids, pick, referenced) => {
          const target = ids[pick % ids.length] ?? ''
          const request = decode({
            ...base,
            ...(referenced ? { medicationReference: { reference: `#${target}` } } : {}),
            contained: ids.map((id) => ({ resourceType: 'Medication', id })),
          })
          expect(containedMedicationOf(request)?.id).toBe(referenced ? target : ids[0])
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should skip contained entries that are not Medications', () => {
    const request = decode({
      ...base,
      contained: [
        { resourceType: 'Organization', id: 'org' },
        { resourceType: 'Medication', id: 'med' },
      ],
    })
    expect(containedMedicationOf(request)?.id).toBe('med')
  })
})
