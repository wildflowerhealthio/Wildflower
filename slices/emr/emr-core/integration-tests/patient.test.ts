import { describe, expect, test } from 'vite-plus/test'

import { events, queries } from '../src/livestore/index.ts'
import { Extension } from '../src/schemas/index.ts'
import { makePatient } from './fixtures.ts'
import { withStore } from './store-helpers.ts'

describe('Patient livestore round-trip', () => {
  test('commit then get round-trips a Patient with non-trivial extension array', () =>
    withStore(async (store) => {
      const patient = makePatient({
        id: 'p1',
        active: true,
        gender: 'female',
        extension: [
          {
            id: null,
            extension: [],
            url: 'http://example.org/ext/race',
            ...Extension.emptyValueChoice,
            valueString: 'Asian',
          },
          {
            id: null,
            extension: [],
            url: 'http://example.org/ext/note',
            ...Extension.emptyValueChoice,
            valueString: 'preferred',
          },
        ],
      })

      store.commit(events.patientUpsert({ resource: patient }))
      const fetched = store.query(queries.patientGetById$('p1'))

      expect(fetched).toBeDefined()
      expect(fetched?.id).toBe('p1')
      expect(fetched?.active).toBe(true)
      expect(fetched?.gender).toBe('female')
      expect(fetched?.extension).toHaveLength(2)
      expect(fetched?.extension[0]?.url).toBe('http://example.org/ext/race')
      expect(fetched?.extension[0]?.valueString).toBe('Asian')
      expect(fetched?.extension[1]?.url).toBe('http://example.org/ext/note')
    }))

  test('two upserts with the same id — second commit overwrites the first', () =>
    withStore(async (store) => {
      store.commit(events.patientUpsert({ resource: makePatient({ id: 'p1', gender: 'male' }) }))
      store.commit(events.patientUpsert({ resource: makePatient({ id: 'p1', gender: 'female' }) }))
      const fetched = store.query(queries.patientGetById$('p1'))
      expect(fetched?.gender).toBe('female')
      // The id is the primary key — only one row should remain.
      const all = store.query(queries.patientAll$)
      expect(all).toHaveLength(1)
    }))
})
