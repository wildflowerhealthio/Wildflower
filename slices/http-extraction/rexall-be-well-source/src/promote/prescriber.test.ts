import { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { MedicationRequest, Practitioner } from '@wildflowerhealthio/fhir-r4/resources'
import { Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { promoteMedicationRequest } from './medication-request.ts'
import { REXALL_PRACTITIONER_NAME_SYSTEM } from './prescriber.ts'

/** A request whose `requester` is `requester`, and nothing else. */
const requestedBy = (
  requester: IdentifierAndReference.ReferenceType | null
): MedicationRequest.Type => ({ ...MedicationRequest.empty, requester })

describe('promoteMedicationRequest, on the prescriber', () => {
  it("should name a prescriber known only by display by the logical reference to that name in Rexall's name system", () => {
    // Arrange
    const request = requestedBy({
      ...IdentifierAndReference.emptyReference,
      display: ' DR  PATEL',
    })

    // Act
    const promoted = promoteMedicationRequest(request)

    // Assert
    expect(promoted.requester).toEqual(
      Option.getOrThrow(
        Practitioner.tryReferenceFromName(REXALL_PRACTITIONER_NAME_SYSTEM, ' DR  PATEL')
      )
    )
    expect([
      promoted.requester?.identifier?.system?.href,
      promoted.requester?.identifier?.value,
    ]).toEqual([
      'https://wildflowerhealth.io/fhir/sid/rexall-be-well/practitioner-name',
      'DR PATEL',
    ])
  })

  it.each([
    { case: 'a blank name', requester: { ...IdentifierAndReference.emptyReference, display: ' ' } },
    { case: 'no name', requester: IdentifierAndReference.emptyReference },
  ])('should drop a display-only requester with $case', ({ requester }) => {
    expect(promoteMedicationRequest(requestedBy(requester)).requester).toBeNull()
  })

  it.each([
    {
      case: 'a literal',
      requester: { ...IdentifierAndReference.emptyReference, reference: 'Practitioner/dr-smith' },
    },
    {
      case: 'an identifier',
      requester: {
        ...IdentifierAndReference.emptyReference,
        display: 'DR PATEL',
        identifier: Option.getOrThrow(
          Practitioner.nameIdentifier(REXALL_PRACTITIONER_NAME_SYSTEM, 'Dr. Patel')
        ),
      },
    },
    { case: 'no requester', requester: null },
  ])('should leave a requester with $case as it is', ({ requester }) => {
    expect(promoteMedicationRequest(requestedBy(requester)).requester).toEqual(requester)
  })
})
