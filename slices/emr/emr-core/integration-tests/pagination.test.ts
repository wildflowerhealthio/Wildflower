import { describe, expect, test } from 'vite-plus/test'

import { events, Patient } from '../src/livestore/index.ts'
import { makePatient } from './fixtures.ts'
import { withStore } from './store-helpers.ts'

describe('Patient pagination via search$/count$', () => {
  test('25 patients, _count=10, traverse next/previous correctly', () =>
    withStore(async (store) => {
      // Pad to 3 digits so SQLite's lexicographic order matches numeric order.
      for (let i = 0; i < 25; i += 1) {
        const id = `p${String(i).padStart(3, '0')}`
        store.commit(events.patientUpsert({ resource: makePatient({ id }) }))
      }

      const total = store.query(Patient.queries.count$({}))
      expect(total).toBe(25)

      const page1 = store.query(Patient.queries.search$({ limit: 10, offset: 0 }))
      expect(page1).toHaveLength(10)
      expect(page1[0]?.id).toBe('p000')
      expect(page1[9]?.id).toBe('p009')

      const page2 = store.query(Patient.queries.search$({ limit: 10, offset: 10 }))
      expect(page2).toHaveLength(10)
      expect(page2[0]?.id).toBe('p010')
      expect(page2[9]?.id).toBe('p019')

      const page3 = store.query(Patient.queries.search$({ limit: 10, offset: 20 }))
      expect(page3).toHaveLength(5)
      expect(page3[0]?.id).toBe('p020')
      expect(page3[4]?.id).toBe('p024')

      // "Previous" of page 3 is page 2 — verify by re-issuing with offset=10.
      const previousOfPage3 = store.query(Patient.queries.search$({ limit: 10, offset: 10 }))
      expect(previousOfPage3.map((p) => p.id)).toEqual(page2.map((p) => p.id))
    }))
})
