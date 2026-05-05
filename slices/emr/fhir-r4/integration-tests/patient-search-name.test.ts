import { Effect } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import { samplePatient } from './fixtures.ts'
import { wireServerScoped } from './server-helpers.ts'

// The `name` search parameter is not implemented today (Patient search
// supports only gender, active, birthdate, _count, _pageToken — see
// `Capability Statement.md`). The typed client's `SearchByGet` enforces the
// declared params, so we can't exercise `?name=...` directly without going
// off-API. This file pins the *currently implemented* search-by-gender path
// and leaves a `test.todo` for the name expansion the bot calls out.
describe('GET /Patient search params', () => {
  test('searches by gender and returns matching patients', () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const wired = yield* wireServerScoped

          yield* Effect.all([
            wired.resources.Patient.Create({
              payload: samplePatient('p1', { gender: 'male' }),
            }),
            wired.resources.Patient.Create({
              payload: samplePatient('p2', { gender: 'female' }),
            }),
            wired.resources.Patient.Create({
              payload: samplePatient('p3', { gender: 'female' }),
            }),
          ])

          const bundle = yield* wired.resources.Patient.SearchByGet({
            urlParams: { gender: 'female' },
          })

          expect(bundle.resourceType).toBe('Bundle')
          expect(bundle.type).toBe('searchset')
          expect(bundle.total).toBe(2)
          expect(bundle.entry).toHaveLength(2)
        })
      )
    ))

  test.todo('searches by name once the search-params expansion lands (gap)')
})
