import { describe, expect, test } from 'vite-plus/test'

import { events, queries } from '../src/livestore/index.ts'
import { makeObservation, makePatient } from './fixtures.ts'
import { withStore } from './store-helpers.ts'

describe('Observation livestore round-trip', () => {
  test('Observation with subject = Reference(Patient/p1) survives round-trip', () =>
    withStore(async (store) => {
      store.commit(events.patientUpsert({ resource: makePatient({ id: 'p1' }) }))
      store.commit(
        events.observationUpsert({
          resource: makeObservation({ id: 'o1', subjectReference: 'Patient/p1' }),
        })
      )

      const observation = store.query(queries.observationGetById$('o1'))
      expect(observation).toBeDefined()
      expect(observation?.id).toBe('o1')
      expect(observation?.subject?.reference).toBe('Patient/p1')

      // The reference resolves: the Patient with the referenced id is in the
      // store and fetchable.
      const patient = store.query(queries.patientGetById$('p1'))
      expect(patient?.id).toBe('p1')
    }))
})
