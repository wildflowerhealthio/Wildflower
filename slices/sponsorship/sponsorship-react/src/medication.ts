import { DateTime, Option, Schema } from 'effect'
import type { MedicationRequest } from 'fhir-r4/resources'
import type { Medication } from 'sponsorship-core'

/** The decoded FHIR R4 `MedicationRequest` resource. */
type MedicationRequestResource = Schema.Schema.Type<typeof MedicationRequest.Schema>

const nonEmpty = (value: string | null | undefined): string | null =>
  value !== null && value !== undefined && value.length > 0 ? value : null

// The FHIR `medication[x]` choice slots are typed `any` on the decoded
// resource (a passthrough choice-element set). Rather than read `any`, we take
// each slot as `unknown` and decode it through a permissive local schema that
// names only the two fields we display — type-safe, and tolerant of both the
// wire and decoded shapes.
const nullableString = Schema.optional(Schema.NullOr(Schema.String))
const MedicationConcept = Schema.Struct({
  text: nullableString,
  coding: Schema.optional(Schema.Array(Schema.Struct({ display: nullableString }))),
})
const MedicationReference = Schema.Struct({ display: nullableString })
const decodeConcept = Schema.decodeUnknownOption(MedicationConcept)
const decodeReference = Schema.decodeUnknownOption(MedicationReference)

/**
 * Best human-readable name for the medication, preferring the inline
 * `medicationCodeableConcept` text, then its first coding display, then a
 * referenced medication's display. Falls back to a generic label so a row
 * always renders.
 */
const displayNameOf = (request: MedicationRequestResource): string => {
  const conceptSlot: unknown = request.medicationCodeableConcept
  const concept = decodeConcept(conceptSlot)
  if (Option.isSome(concept)) {
    const text = nonEmpty(concept.value.text)
    if (text !== null) return text
    for (const coding of concept.value.coding ?? []) {
      const display = nonEmpty(coding.display)
      if (display !== null) return display
    }
  }
  const referenceSlot: unknown = request.medicationReference
  const reference = decodeReference(referenceSlot)
  if (Option.isSome(reference)) {
    const display = nonEmpty(reference.value.display)
    if (display !== null) return display
  }
  return 'Unknown medication'
}

/**
 * Map a decoded FHIR `MedicationRequest` onto the `sponsorship-core`
 * {@link Medication} value the matcher and UI consume. `fallbackId` supplies a
 * stable React key when the resource carries no `id`.
 */
const medicationRequestToMedication = (
  request: MedicationRequestResource,
  fallbackId: string
): Medication => ({
  id: nonEmpty(request.id) ?? fallbackId,
  displayName: displayNameOf(request),
  status: request.status,
  authoredOn:
    request.authoredOn === null || request.authoredOn === undefined
      ? undefined
      : DateTime.formatIso(request.authoredOn),
})

/** Map a bundle's worth of requests, deriving fallback keys from position. */
const medicationRequestsToMedications = (
  requests: readonly MedicationRequestResource[]
): readonly Medication[] =>
  requests.map((request, index) =>
    medicationRequestToMedication(request, `medication-request-${index}`)
  )

export {
  medicationRequestToMedication,
  medicationRequestsToMedications,
  type MedicationRequestResource,
}
