import { Either } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import * as PatientSummary from './patient-summary.ts'

describe('fromSearchBundle', () => {
  it('should list each patient with the id, names and birth date the server sent', () => {
    // Arrange
    const response = searchBundle([
      {
        resourceType: 'Patient',
        id: 'ada',
        name: [{ given: ['Ada'], family: 'Lovelace' }],
        birthDate: '1815-12-10',
      },
    ])

    // Act
    const patients = PatientSummary.fromSearchBundle(response)

    // Assert
    expect(patients).toStrictEqual(
      Either.right([
        {
          resourceType: 'Patient',
          id: 'ada',
          name: [{ given: ['Ada'], family: 'Lovelace' }],
          birthDate: '1815-12-10',
        },
      ])
    )
  })

  it('should keep a partial birth date as the server wrote it', () => {
    // Arrange
    const response = searchBundle([
      { resourceType: 'Patient', id: 'year', birthDate: '1970' },
      { resourceType: 'Patient', id: 'month', birthDate: '1970-05' },
    ])

    // Act
    const patients = PatientSummary.fromSearchBundle(response)

    // Assert
    expect(birthDates(patients)).toStrictEqual(Either.right(['1970', '1970-05']))
  })

  it('should give a patient with no names or birth date an empty name list and null', () => {
    // Act
    const patients = PatientSummary.fromSearchBundle(
      searchBundle([{ resourceType: 'Patient', id: 'ada' }])
    )

    // Assert
    expect(patients).toStrictEqual(
      Either.right([{ resourceType: 'Patient', id: 'ada', name: [], birthDate: null }])
    )
  })

  it("should drop given's null placeholders and keep the patient", () => {
    // Arrange — FHIR JSON pads `given` with `null` where `_given` carries an extension
    const response = searchBundle([
      { resourceType: 'Patient', id: 'ada', name: [{ given: ['Ada', null], family: 'Lovelace' }] },
    ])

    // Act
    const patients = PatientSummary.fromSearchBundle(response)

    // Assert
    expect(names(patients)).toStrictEqual(Either.right([[{ given: ['Ada'], family: 'Lovelace' }]]))
  })

  it('should drop a malformed name and keep the patient with the rest', () => {
    // Arrange
    const response = searchBundle([
      {
        resourceType: 'Patient',
        id: 'ada',
        name: [
          { use: 'official', given: ['Augusta'], period: { end: 123 } },
          'not a name',
          { given: ['Ada'], family: 'Lovelace' },
        ],
      },
    ])

    // Act
    const patients = PatientSummary.fromSearchBundle(response)

    // Assert
    expect(names(patients)).toStrictEqual(Either.right([[{ given: ['Ada'], family: 'Lovelace' }]]))
  })

  it('should drop a malformed entry and list the rest', () => {
    // Arrange — no id, a numeric birth date, a non-Patient, and an empty entry
    const response = searchBundle([
      { resourceType: 'Patient', name: [{ text: 'No id' }] },
      { resourceType: 'Patient', id: 'ada', birthDate: '1815-12-10' },
      { resourceType: 'Patient', id: 'bad-date', birthDate: 1970 },
      { resourceType: 'OperationOutcome', id: 'warning' },
      undefined,
      { resourceType: 'Patient', id: 'grace', birthDate: '1906' },
    ])

    // Act
    const patients = PatientSummary.fromSearchBundle(response)

    // Assert
    expect(Either.map(patients, (listed) => listed.map(({ id }) => id))).toStrictEqual(
      Either.right(['ada', 'grace'])
    )
  })

  it('should read a search with no entries as no patients', () => {
    expect(
      PatientSummary.fromSearchBundle({ resourceType: 'Bundle', type: 'searchset' })
    ).toStrictEqual(Either.right([]))
  })

  it('should fail on a response that is not a bundle', () => {
    expect(
      Either.isLeft(PatientSummary.fromSearchBundle({ resourceType: 'OperationOutcome' }))
    ).toBe(true)
  })

  it('should list exactly the entries that are patients with an id, in server order', () => {
    fc.assert(
      fc.property(fc.array(entryArb), (resources) => {
        // Arrange
        const expectedIds = resources.flatMap((resource) =>
          resource.resourceType === 'Patient' && resource.id !== undefined && resource.id !== ''
            ? [resource.id]
            : []
        )

        // Act
        const patients = PatientSummary.fromSearchBundle(searchBundle(resources))

        // Assert
        expect(Either.map(patients, (listed) => listed.map(({ id }) => id))).toStrictEqual(
          Either.right(expectedIds)
        )
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

// Helpers

/** A `searchset` bundle whose entries carry `resources`. */
const searchBundle = (resources: readonly unknown[]): unknown => ({
  resourceType: 'Bundle',
  type: 'searchset',
  entry: resources.map((resource) => ({ resource })),
})

/** The listed patients' birth dates. */
const birthDates = (
  patients: ReturnType<typeof PatientSummary.fromSearchBundle>
): Either.Either<readonly (string | null)[], unknown> =>
  Either.map(patients, (listed) => listed.map(({ birthDate }) => birthDate))

/** Each listed patient's names. */
const names = (
  patients: ReturnType<typeof PatientSummary.fromSearchBundle>
): Either.Either<readonly (readonly unknown[])[], unknown> =>
  Either.map(patients, (listed) => listed.map(({ name }) => name))

/** A search entry: a patient with or without an id, or another resource type. */
const entryArb = fc.record(
  {
    resourceType: fc.constantFrom('Patient', 'OperationOutcome'),
    id: fc.string(),
    birthDate: fc.string(),
  },
  { requiredKeys: ['resourceType'] }
)
