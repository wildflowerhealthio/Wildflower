import { Effect, Option, Schema, TestClock, TestContext } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { FhirResourceSchema } from './fhir-resource.ts'
import * as PersonName from './person-name.ts'

/** Covers the name a Patient or a Practitioner is shown by, judged at the clock's now. */

const decode = Schema.decodeUnknownSync(FhirResourceSchema)

/** `effect` run on the test clock set to `now`. */
const runAt = <A>(now: string, effect: Effect.Effect<A>): Promise<A> =>
  Effect.runPromise(
    Effect.provide(
      Effect.zipRight(TestClock.setTime(Date.parse(now)), effect),
      TestContext.TestContext
    )
  )

describe('PersonName.maybeDisplayName', () => {
  it('should show a Patient by the name current at the clock’s now', async () => {
    // Arrange
    const patient = decode({
      resourceType: 'Patient',
      name: [
        { use: 'official', family: 'Ashford', given: ['Tyra'], period: { end: '2020-01-01' } },
        { use: 'official', family: 'Reyes', given: ['Tyra'] },
      ],
    })

    // Act
    const name = await runAt('2026-01-01T00:00:00Z', PersonName.maybeDisplayName(patient))

    // Assert
    expect(name).toEqual(Option.some('Tyra Reyes'))
  })

  it('should show a Practitioner named only as text by that text', async () => {
    // Arrange
    const practitioner = decode({ resourceType: 'Practitioner', name: [{ text: 'Dr. Brown' }] })

    // Act
    const name = await runAt('2026-01-01T00:00:00Z', PersonName.maybeDisplayName(practitioner))

    // Assert
    expect(name).toEqual(Option.some('Dr. Brown'))
  })

  it.each([
    {
      name: 'a resource of another type',
      wire: { resourceType: 'Binary', contentType: 'text/plain' },
    },
    { name: 'a Patient with no name', wire: { resourceType: 'Patient' } },
  ])('should show no name for $name', async ({ wire }) => {
    // Arrange
    const resource = decode(wire)

    // Act
    const name = await runAt('2026-01-01T00:00:00Z', PersonName.maybeDisplayName(resource))

    // Assert
    expect(name).toEqual(Option.none())
  })
})
