import { HttpApiBuilder, HttpServer } from '@effect/platform'
import { Layer } from 'effect'
import { EmrStore } from 'emr-core/livestore'
import type { Observation as StoreObservation, Patient as StorePatient } from 'emr-core/livestore'
import { Query } from 'emr-core/telemetry'
import { Origin } from 'navigation-core'
import { describe, expect, test } from 'vite-plus/test'

import { FhirResourcesApiLive } from './index.ts'

type PatientRow = typeof StorePatient.RowSchema.Type
type ObservationRow = typeof StoreObservation.RowSchema.Type

const patient = (id: string): PatientRow & { readonly id: string } => ({
  resourceType: 'Patient',
  id,
  meta: { versionId: '', lastUpdated: null, source: '', profile: [], security: [], tag: [] },
  implicitRules: new URL('http://a.aa/'),
  language: null,
  active: false,
  address: [],
  birthDate: null,
  communication: [],
  contact: [],
  deceasedBoolean: false,
  deceasedDateTime: null,
  gender: null,
  generalPractitioner: [],
  identifier: [],
  link: [],
  managingOrganization: null,
  maritalStatus: null,
  multipleBirthBoolean: false,
  multipleBirthInteger: null,
  name: [],
  photo: [],
  telecom: [],
  contained: [],
  extension: [],
  modifierExtension: [],
  text: null,
})

const subjectFor = (reference: string | null): ObservationRow['subject'] => {
  if (reference === null) {
    return null
  }
  return {
    id: null,
    extension: [],
    display: null,
    reference,
    type: null,
    identifier: null,
  }
}

const observation = (
  id: string,
  subjectReference: string | null
): ObservationRow & { readonly id: string } => ({
  resourceType: 'Observation',
  id,
  meta: { versionId: '', lastUpdated: null, source: '', profile: [], security: [], tag: [] },
  implicitRules: null,
  language: null,
  contained: [],
  extension: [],
  modifierExtension: [],
  text: null,
  basedOn: [],
  bodySite: null,
  category: [],
  code: { id: null, extension: [], coding: [], text: null },
  component: [],
  dataAbsentReason: null,
  derivedFrom: [],
  device: null,
  effectiveDateTime: null,
  effectivePeriod: null,
  effectiveTiming: null,
  effectiveInstant: null,
  encounter: null,
  focus: [],
  hasMember: [],
  identifier: [],
  interpretation: [],
  issued: null,
  method: null,
  note: [],
  partOf: [],
  performer: [],
  referenceRange: [],
  specimen: null,
  status: 'final',
  subject: subjectFor(subjectReference),
  valueQuantity: null,
  valueCodeableConcept: null,
  valueString: null,
  valueBoolean: null,
  valueInteger: null,
  valueRange: null,
  valueRatio: null,
  valueSampledData: null,
  valueTime: null,
  valueDateTime: null,
  valuePeriod: null,
})

interface MockData {
  readonly patients: ReadonlyArray<PatientRow & { readonly id: string }>
  readonly observations: ReadonlyArray<ObservationRow & { readonly id: string }>
}

// Mock store that branches on the LiveQueryDef's `label` field. Labels are
// produced by domain-resource-persistence via the emr-core telemetry catalog.
const makeStore = (data: MockData): typeof EmrStore.Service =>
  /* oxlint-disable-next-line typescript/no-unsafe-type-assertion */
  ({
    query: (q: { readonly label?: string }): unknown => {
      const label = q.label ?? ''
      if (label === Query.GetById('Patient')) {
        return data.patients[0]
      }
      if (label === Query.GetById('Observation')) {
        return data.observations[0]
      }
      if (label === Query.Count('Patient')) {
        return data.patients.length
      }
      if (label === Query.Count('Observation')) {
        return data.observations.length
      }
      if (label === Query.Search('Patient') || label === Query.All('Patient')) {
        return data.patients
      }
      return data.observations
    },
    commit: () => undefined,
  }) as unknown as typeof EmrStore.Service

const createHandler = (data: MockData): ReturnType<typeof HttpApiBuilder.toWebHandler> => {
  const apiLive = FhirResourcesApiLive.pipe(
    Layer.provide(EmrStore.layerFrom(makeStore(data))),
    Layer.provide(Origin.layerFromLiteral('http://localhost:8787'))
  )
  return HttpApiBuilder.toWebHandler(Layer.merge(apiLive, HttpServer.layerContext))
}

interface BundleEntry {
  readonly resource: { readonly resourceType: string; readonly id: string }
  readonly search: { readonly mode: string }
}
interface BundleLink {
  readonly relation: string
  readonly url: string
}
interface BundleResponse {
  readonly resourceType: string
  readonly type: string
  readonly total: number
  readonly entry: ReadonlyArray<BundleEntry>
  readonly link: ReadonlyArray<BundleLink>
}

const parseBundle = async (response: Response): Promise<BundleResponse> => {
  const json: unknown = await response.json()
  /* oxlint-disable-next-line typescript/no-unsafe-type-assertion */
  return json as BundleResponse
}

describe('Patient $everything endpoint', () => {
  test('returns Bundle with patient and matching Observations', async () => {
    const { handler, dispose } = createHandler({
      patients: [patient('p1')],
      observations: [
        observation('o1', 'Patient/p1'),
        observation('o2', 'Patient/p2'),
        observation('o3', 'Patient/p1'),
        observation('o4', null),
      ],
    })
    try {
      const response = await handler(
        new Request('http://localhost:8787/fhir-r4/Patient/p1/$everything')
      )
      expect(response.status).toBe(200)
      const body = await parseBundle(response)
      expect(body.resourceType).toBe('Bundle')
      expect(body.type).toBe('searchset')
      // primary patient + 2 observations referencing Patient/p1
      expect(body.entry).toHaveLength(3)
      expect(body.total).toBe(3)
      expect(body.entry[0]?.resource.resourceType).toBe('Patient')
      expect(body.entry[0]?.resource.id).toBe('p1')
      const observationIds = body.entry.slice(1).map((e) => e.resource.id)
      expect(observationIds).toEqual(['o1', 'o3'])
      expect(body.link.some((l) => l.relation === 'self')).toBe(true)
    } finally {
      await dispose()
    }
  })

  test('respects _count by truncating related resources', async () => {
    const { handler, dispose } = createHandler({
      patients: [patient('p1')],
      observations: [
        observation('o1', 'Patient/p1'),
        observation('o2', 'Patient/p1'),
        observation('o3', 'Patient/p1'),
      ],
    })
    try {
      const response = await handler(
        new Request('http://localhost:8787/fhir-r4/Patient/p1/$everything?_count=2')
      )
      expect(response.status).toBe(200)
      const body = await parseBundle(response)
      // primary patient + 2 of 3 observations
      expect(body.entry).toHaveLength(3)
      const observationIds = body.entry.slice(1).map((e) => e.resource.id)
      expect(observationIds).toEqual(['o1', 'o2'])
    } finally {
      await dispose()
    }
  })

  test('returns 404 when patient does not exist', async () => {
    const { handler, dispose } = createHandler({ patients: [], observations: [] })
    try {
      const response = await handler(
        new Request('http://localhost:8787/fhir-r4/Patient/missing/$everything')
      )
      expect(response.status).toBe(404)
    } finally {
      await dispose()
    }
  })
})

describe('Observation $everything endpoint', () => {
  test('returns Bundle containing only the Observation itself', async () => {
    const { handler, dispose } = createHandler({
      patients: [],
      observations: [observation('o1', 'Patient/p1')],
    })
    try {
      const response = await handler(
        new Request('http://localhost:8787/fhir-r4/Observation/o1/$everything')
      )
      expect(response.status).toBe(200)
      const body = await parseBundle(response)
      expect(body.resourceType).toBe('Bundle')
      expect(body.type).toBe('searchset')
      expect(body.entry).toHaveLength(1)
      expect(body.total).toBe(1)
      expect(body.entry[0]?.resource.resourceType).toBe('Observation')
      expect(body.entry[0]?.resource.id).toBe('o1')
    } finally {
      await dispose()
    }
  })
})
