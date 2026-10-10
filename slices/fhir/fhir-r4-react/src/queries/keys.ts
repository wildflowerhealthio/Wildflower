/**
 * Query-key roots shared across the FHIR R4 resource modules.
 *
 * The patient list is read-only here (the consenting-owner patient
 * picker in `gatekeeper-react`), so there's no mutation invalidating it
 * — the key still lives here so any future FHIR read/write surface keys
 * off one source of truth.
 */

const PATIENTS_QUERY_KEY = ['fhir-r4', 'patients'] as const

export { PATIENTS_QUERY_KEY }
