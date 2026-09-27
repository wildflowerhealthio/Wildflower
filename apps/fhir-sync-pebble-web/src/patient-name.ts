import type { PatientResource } from 'fhir-r4-react'

/**
 * A patient's first non-blank name — `given family` when the name has parts,
 * else its `text` — or `null` when the record has none. The settings page shows
 * it, and the watch receives the same string to confirm the patient on-device.
 */
const patientName = (patient: PatientResource): string | null =>
  patient.name
    .map((name) => {
      const joined = [...name.given, name.family ?? ''].join(' ').trim()
      return joined.length > 0 ? joined : (name.text ?? '').trim()
    })
    .find((text) => text.length > 0) ?? null

export { patientName }
