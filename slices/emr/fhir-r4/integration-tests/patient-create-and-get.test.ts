import { Effect } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import { samplePatient } from './fixtures.ts'
import { wireServerScoped } from './server-helpers.ts'

describe('POST /Patient → GET /Patient/{id}', () => {
  test('round-trips through the wire and preserves shape', () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // Arrange
          const wired = yield* wireServerScoped

          // Act
          const created = yield* wired.resources.Patient.Create({
            payload: samplePatient('p1'),
          })
          const fetched = yield* wired.resources.Patient.GetById({ path: { id: 'p1' } })

          // Assert
          expect(created.resourceType).toBe('Patient')
          expect(created.id).toBe('p1')
          expect(fetched.id).toBe('p1')
          expect(fetched.resourceType).toBe('Patient')
          expect(fetched.active).toBe(true)
          expect(fetched.gender).toBe('female')
          expect(fetched.name[0]?.family).toBe('Doe')
          expect(fetched.name[0]?.given).toEqual(['Jane'])
        })
      )
    ))
})
