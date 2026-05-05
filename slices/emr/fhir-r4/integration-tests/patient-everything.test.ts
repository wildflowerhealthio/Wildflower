import { Effect } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import { sampleObservation, samplePatient } from './fixtures.ts'
import { wireServerScoped } from './server-helpers.ts'

describe('GET /Patient/{id}/$everything', () => {
  test('returns Bundle: primary patient first, then referencing observations', () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // Arrange — two patients; only one is the $everything target.
          // Three referencing observations + one for the other patient + one
          // unsubscribed: only the three matching ones should be in the
          // bundle.
          const wired = yield* wireServerScoped
          yield* Effect.all([
            wired.resources.Patient.Create({ payload: samplePatient('p1') }),
            wired.resources.Patient.Create({ payload: samplePatient('p2') }),
          ])
          yield* Effect.all(
            ['o1', 'o2', 'o3'].map((id) =>
              wired.resources.Observation.Create({ payload: sampleObservation(id, 'p1') })
            )
          )
          yield* wired.resources.Observation.Create({
            payload: sampleObservation('o-other', 'p2'),
          })

          // Act
          const bundle = yield* wired.resources.Patient.Everything({
            path: { id: 'p1' },
            urlParams: {},
          })

          // Assert
          expect(bundle.resourceType).toBe('Bundle')
          expect(bundle.type).toBe('searchset')
          expect(bundle.total).toBe(4)
          expect(bundle.entry).toHaveLength(4)
          expect(bundle.entry[0]?.resource?.resourceType).toBe('Patient')
          expect(bundle.entry[0]?.resource?.id).toBe('p1')
          const observationIds = bundle.entry
            .slice(1)
            .map((e) => e.resource?.id ?? '')
            .toSorted((a, b) => a.localeCompare(b))
          expect(observationIds).toEqual(['o1', 'o2', 'o3'])
          for (const entry of bundle.entry) {
            expect(entry.search?.mode).toBe('match')
          }
        })
      )
    ))
})
