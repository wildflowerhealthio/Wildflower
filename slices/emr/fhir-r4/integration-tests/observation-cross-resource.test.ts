import { Effect } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import { sampleObservation, samplePatient } from './fixtures.ts'
import { wireServerScoped } from './server-helpers.ts'

describe('POST /Observation referencing Patient', () => {
  test('cross-resource reference resolves via REST GET on the referenced patient', () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // Arrange
          const wired = yield* wireServerScoped
          yield* wired.resources.Patient.Create({ payload: samplePatient('p1') })

          // Act
          const observation = yield* wired.resources.Observation.Create({
            payload: sampleObservation('o1', 'p1'),
          })
          const fetchedPatient = yield* wired.resources.Patient.GetById({
            path: { id: 'p1' },
          })

          // Assert
          expect(observation.subject?.reference).toBe('Patient/p1')
          expect(fetchedPatient.resourceType).toBe('Patient')
          expect(fetchedPatient.id).toBe('p1')
        })
      )
    ))
})
