import { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { MedicationRequest, Practitioner } from '@wildflowerhealthio/fhir-r4/resources'
import { Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { promoteMedicationRequest } from './medication-request.ts'

/** A request whose `requester` is `requester`, and nothing else. */
const requestedBy = (
  requester: IdentifierAndReference.ReferenceType | null
): MedicationRequest.Type => ({ ...MedicationRequest.empty, requester })

describe('promoteMedicationRequest, on the prescriber', () => {
  it('should name a prescriber known only by display by the logical reference to that name', () => {
    // Arrange
    const request = requestedBy({
      ...IdentifierAndReference.emptyReference,
      display: ' DR  PATEL',
    })

    // Act
    const promoted = promoteMedicationRequest(request)

    // Assert
    expect(promoted.requester).toEqual(
      Option.getOrThrow(Practitioner.tryReferenceFromName(' DR  PATEL'))
    )
    expect(promoted.requester?.identifier?.value).toBe('DR PATEL')
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
        identifier: Option.getOrThrow(Practitioner.nameIdentifier('Dr. Patel')),
      },
    },
    { case: 'no requester', requester: null },
  ])('should leave a requester with $case as it is', ({ requester }) => {
    expect(promoteMedicationRequest(requestedBy(requester)).requester).toEqual(requester)
  })
})
