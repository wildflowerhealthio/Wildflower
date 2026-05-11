/**
 * Tiny HTTP-only client for the wildflower FHIR R4 server. The
 * collector SPA's sync runner calls these PUTs once it's parsed a
 * sniffer-scraped entity — the server translates each PUT into the
 * corresponding `*Upserted` event in its own store.
 *
 * Resource URLs look like `{serverUrl}/fhir-r4/{ResourceType}/{id}`.
 * `serverUrl` comes from the SPA's `useFhirR4ServerUrl()` hook — the
 * Expo host issues it via `CollectorBridge.FhirR4ServerUrlIssued`, with
 * an explicit `<FhirR4ServerUrlProvider value={...}>` override available
 * for tests and externally-managed FHIR servers.
 */

import { Schema } from 'effect'

import type {
  Binary as StoreBinary,
  Observation as StoreObservation,
  Patient as StorePatient,
} from 'emr-core/livestore'
import { withMandatoryId } from 'fhir-r4/data-types'
import {
  Binary as FhirBinary,
  Observation as FhirObservation,
  Patient as FhirPatient,
} from 'fhir-r4/resources'

const FHIR_PREFIX = '/fhir-r4'

const encodeBinary = Schema.encodeSync(withMandatoryId(FhirBinary.Schema))
const encodePatient = Schema.encodeSync(withMandatoryId(FhirPatient.Schema))
const encodeObservation = Schema.encodeSync(withMandatoryId(FhirObservation.Schema))

type BinaryResource = typeof StoreBinary.RowSchemaNullableId.Type
type PatientResource = typeof StorePatient.RowSchemaNullableId.Type
type ObservationResource = typeof StoreObservation.RowSchemaNullableId.Type

async function putResource(
  serverUrl: string,
  resourceType: string,
  id: string,
  body: unknown
): Promise<void> {
  const url = `${serverUrl.replace(/\/$/, '')}${FHIR_PREFIX}/${resourceType}/${id}`
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`PUT ${url} failed with ${res.status}: ${text}`)
  }
}

async function upsertBinary(serverUrl: string, resource: BinaryResource): Promise<void> {
  if (resource.id === null) {
    throw new Error('Binary resource must have an id before upserting')
  }
  const body = encodeBinary({ ...resource, id: resource.id })
  await putResource(serverUrl, 'Binary', resource.id, body)
}

async function upsertPatient(serverUrl: string, resource: PatientResource): Promise<void> {
  if (resource.id === null) {
    throw new Error('Patient resource must have an id before upserting')
  }
  const body = encodePatient({ ...resource, id: resource.id })
  await putResource(serverUrl, 'Patient', resource.id, body)
}

async function upsertObservation(serverUrl: string, resource: ObservationResource): Promise<void> {
  if (resource.id === null) {
    throw new Error('Observation resource must have an id before upserting')
  }
  const body = encodeObservation({ ...resource, id: resource.id })
  await putResource(serverUrl, 'Observation', resource.id, body)
}

export { upsertBinary, upsertPatient, upsertObservation }
export type { BinaryResource, PatientResource, ObservationResource }
