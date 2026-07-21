import { Option, Schema } from 'effect'
import { MedicationRequest } from 'fhir-r4/resources'
import type Client from 'fhirclient/lib/Client'

/** The decoded FHIR R4 `MedicationRequest` resource. */
type MedicationRequestResource = Schema.Schema.Type<typeof MedicationRequest.Schema>

const decodeMedicationRequest = Schema.decodeUnknownOption(MedicationRequest.Schema)

/**
 * Fetch `MedicationRequest`s from the SMART FHIR server, following bundle
 * pagination (`pageLimit: 0`) and flattening to resources. When `patientId` is a
 * string the read is scoped to that patient (a `patient/` launch); when it is
 * `null` — a `system/` launch with no patient in context — every
 * `MedicationRequest` the granted scopes expose is read. Each entry is decoded
 * through the fhir-r4 schema; anything that fails to decode is dropped, so a
 * single malformed row never fails the whole read.
 */
const fetchMedicationRequests = async (
  client: Client,
  patientId: string | null
): Promise<readonly MedicationRequestResource[]> => {
  const query =
    patientId === null
      ? 'MedicationRequest'
      : `MedicationRequest?patient=${encodeURIComponent(patientId)}`
  const response = await client.request<unknown>(query, { flat: true, pageLimit: 0 })
  const items: readonly unknown[] = Array.isArray(response) ? response : []
  return items.flatMap((item) => {
    const decoded = decodeMedicationRequest(item)
    return Option.isSome(decoded) ? [decoded.value] : []
  })
}

export { fetchMedicationRequests, type MedicationRequestResource }
