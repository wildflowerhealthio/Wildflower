import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { localResourceId } from '@wildflowerhealthio/fhir-r4/identity'
import {
  Binary,
  type FhirResourceWithId,
  MedicationDispense,
  MedicationRequest,
  Observation,
  Patient,
} from '@wildflowerhealthio/fhir-r4/resources'
import { Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import * as DecodedFileSet from './decoded-file-set.ts'
import * as DecodedFile from './decoded-file.ts'

/**
 * Covers the import stage's half of a decoded set: adopting every section's
 * detached records under one adoption, and the titles a decoder gives them.
 */

const BASE_URL = 'https://source.example/fhir'

const detachTest = DetachedResource.fromServerRecord(BASE_URL)

const decodePatient = Schema.decodeUnknownSync(Patient.Schema)
const decodeObservation = Schema.decodeUnknownSync(Observation.Schema)
const decodeBinary = Schema.decodeUnknownSync(Binary.Schema)

const patient = (id: string | null): DetachedResource.Type =>
  detachTest(decodePatient({ resourceType: 'Patient', ...(id === null ? {} : { id }) }))

/** The Patient with `id` on the source, carrying `identifier` behind the key its id gives it. */
const patientWith = (
  id: string,
  identifier: readonly Record<string, unknown>[]
): DetachedResource.Type => detachTest(decodePatient({ resourceType: 'Patient', id, identifier }))

const HEALTH_CARD_SYSTEM = 'https://health.example/health-card-number'

/** A logical reference to the Patient carrying the health card number `value`. */
const byHealthCard = (value: string): Record<string, unknown> => ({
  type: 'Patient',
  identifier: { system: HEALTH_CARD_SYSTEM, value },
})

const observationOn = (subject: Record<string, unknown>): DetachedResource.Type =>
  detachTest(
    decodeObservation({
      resourceType: 'Observation',
      id: 'obs-1',
      status: 'final',
      code: { text: 'Weight' },
      subject,
    })
  )

/** A section of `resources`, each identified by its position. */
const sectionOf = (
  title: string,
  resources: readonly DetachedResource.Type[]
): DecodedFileSet.Section => ({
  title,
  entries: resources.map((resource, index) => ({ fullUrl: `${title}:${index}`, resource })),
})

/** A minter that counts: `minted-1`, `minted-2`, …. */
const countingMinter = (): (() => string) => {
  let minted = 0
  return () => {
    minted += 1
    return `minted-${minted}`
  }
}

const adoptedIn = (sections: readonly DecodedFileSet.Section[]): readonly FhirResourceWithId[] =>
  DecodedFile.resources(DecodedFileSet.adopt({ sections, notes: [] }, countingMinter())).map(
    ({ resource }) => resource
  )

const subjectOf = (resource: FhirResourceWithId | undefined): string | null | undefined =>
  resource?.resourceType === 'Observation' ? resource.subject?.reference : undefined

describe('DecodedFileSet.adopt', () => {
  it('stores a keyed record under the id its key derives', () => {
    const [adopted] = adoptedIn([sectionOf('people', [patient('pat-7')])])
    expect(adopted?.id).toBe(localResourceId(`${BASE_URL}/Patient`, 'Patient', 'pat-7'))
  })

  it('stores each keyless record under an id the injected minter mints, in review order', () => {
    const binary = detachTest(decodeBinary({ resourceType: 'Binary', contentType: 'text/plain' }))
    expect(
      adoptedIn([sectionOf('a', [patient(null)]), sectionOf('b', [binary])]).map(({ id }) => id)
    ).toEqual(['minted-1', 'minted-2'])
  })

  it("resolves a reference to a record in another of the set's sections", () => {
    const [person, observation] = adoptedIn([
      sectionOf('people', [patient('pat-7')]),
      sectionOf('results', [observationOn({ reference: 'Patient/pat-7' })]),
    ])
    expect(subjectOf(observation)).toBe(`Patient/${person?.id}`)
  })

  // As a FHIR server leaves a conditional reference that matches nothing in
  // the transaction: nothing is stored under the id its key would derive.
  it('leaves a reference to a record the set does not hold logical, for the identity map', () => {
    const [observation] = adoptedIn([
      sectionOf('results', [observationOn({ reference: 'Patient/pat-9' })]),
    ])
    expect(subjectOf(observation)).toBeNull()
  })

  it('leaves a logical reference by an identifier no record of the set is keyed by for the identity map', () => {
    const account = {
      type: 'Patient',
      identifier: { system: 'https://portal.example/fhir/identifier/customer-id', value: 'acct-1' },
    }
    const [observation] = adoptedIn([sectionOf('results', [observationOn(account)])])
    expect(observation?.resourceType === 'Observation' ? observation.subject : null).toMatchObject({
      reference: null,
      ...account,
      identifier: { system: new URL(account.identifier.system), value: 'acct-1' },
    })
  })

  // As a FHIR conditional reference matches a record by any of its identifiers.
  it('resolves a reference by an identifier of a record other than its key', () => {
    const [person, observation] = adoptedIn([
      sectionOf('people', [
        patientWith('pat-7', [{ system: HEALTH_CARD_SYSTEM, value: '1234-567-890' }]),
      ]),
      sectionOf('results', [observationOn(byHealthCard('1234-567-890'))]),
    ])
    expect(subjectOf(observation)).toBe(`Patient/${person?.id}`)
  })

  it('leaves a reference by an identifier two records of the set share logical, naming neither', () => {
    const sharedCard = [{ system: HEALTH_CARD_SYSTEM, value: '1234-567-890' }]
    const [first, , byCard, byKey] = adoptedIn([
      sectionOf('people', [patientWith('pat-7', sharedCard), patientWith('pat-8', sharedCard)]),
      sectionOf('results', [
        observationOn(byHealthCard('1234-567-890')),
        observationOn({ reference: 'Patient/pat-7' }),
      ]),
    ])
    expect([subjectOf(byCard), subjectOf(byKey)]).toEqual([null, `Patient/${first?.id}`])
  })

  it('resolves a reference to a record listing its key, or another identifier, twice', () => {
    const card = { system: HEALTH_CARD_SYSTEM, value: '1234-567-890' }
    const [person, byCard, byKey] = adoptedIn([
      sectionOf('people', [
        patientWith('pat-7', [card, { system: `${BASE_URL}/Patient`, value: 'pat-7' }, card]),
      ]),
      sectionOf('results', [
        observationOn(byHealthCard('1234-567-890')),
        observationOn({ reference: 'Patient/pat-7' }),
      ]),
    ])
    expect([subjectOf(byCard), subjectOf(byKey)]).toEqual([
      `Patient/${person?.id}`,
      `Patient/${person?.id}`,
    ])
  })

  // A keyless record's id is minted at import, so nothing names it by key:
  // not even an identifier it carries behind an unqualified first one.
  it('leaves a reference to a keyless record of the set logical, whatever identifiers it carries', () => {
    const keyless = detachTest(
      decodePatient({
        resourceType: 'Patient',
        identifier: [{ value: 'unqualified' }, { system: `${BASE_URL}/Patient`, value: 'pat-7' }],
      })
    )
    const [person, observation] = adoptedIn([
      sectionOf('people', [keyless]),
      sectionOf('results', [observationOn({ reference: 'Patient/pat-7' })]),
    ])
    expect([person?.id, subjectOf(observation)]).toEqual(['minted-1', null])
  })
})

describe('DecodedFileSet.adopt, a dispense whose subject names no Patient of the set', () => {
  const decodeRequest = Schema.decodeUnknownSync(MedicationRequest.Schema)
  const decodeDispense = Schema.decodeUnknownSync(MedicationDispense.Schema)

  const ACCOUNT = {
    type: 'Patient',
    identifier: { system: 'https://portal.example/fhir/identifier/customer-id', value: 'acct-1' },
  }

  /** The prescription `id` on the source, for the Patient `patientId`. */
  const prescriptionFor = (id: string, patientId: string): DetachedResource.Type =>
    detachTest(
      decodeRequest({
        resourceType: 'MedicationRequest',
        id,
        status: 'active',
        intent: 'order',
        medicationCodeableConcept: { text: 'Amoxicillin' },
        subject: { reference: `Patient/${patientId}` },
      })
    )

  /** A fill of the prescriptions `prescriptionIds`, on `subject` when it has one. */
  const dispenseOf = (
    subject: Record<string, unknown> | null,
    prescriptionIds: readonly string[]
  ): DetachedResource.Type =>
    detachTest(
      decodeDispense({
        resourceType: 'MedicationDispense',
        id: 'fill-1',
        status: 'completed',
        medicationCodeableConcept: { text: 'Amoxicillin' },
        ...(subject === null ? {} : { subject }),
        authorizingPrescription: prescriptionIds.map((id) => ({
          reference: `MedicationRequest/${id}`,
        })),
      })
    )

  /** The adopted dispense and the Patient its prescription `rx-7` is for, read out of `records`. */
  const adoptedFill = (
    records: readonly DetachedResource.Type[]
  ): { readonly dispense: FhirResourceWithId | undefined; readonly onPrescription: unknown } => {
    const adopted = adoptedIn([sectionOf('records', records)])
    const request = adopted.find(({ resourceType }) => resourceType === 'MedicationRequest')
    return {
      dispense: adopted.find(({ resourceType }) => resourceType === 'MedicationDispense'),
      onPrescription: request?.resourceType === 'MedicationRequest' ? request.subject : undefined,
    }
  }

  const subjectOfDispense = (dispense: FhirResourceWithId | undefined): unknown =>
    dispense?.resourceType === 'MedicationDispense' ? dispense.subject : undefined

  it.each([
    {
      name: 'its subject names the account',
      records: [patient('pat-7'), prescriptionFor('rx-7', 'pat-7'), dispenseOf(ACCOUNT, ['rx-7'])],
    },
    {
      name: 'it has no subject',
      records: [patient('pat-7'), prescriptionFor('rx-7', 'pat-7'), dispenseOf(null, ['rx-7'])],
    },
    {
      name: 'its prescriptions agree on one Patient',
      records: [
        patient('pat-7'),
        prescriptionFor('rx-7', 'pat-7'),
        prescriptionFor('rx-8', 'pat-7'),
        dispenseOf(ACCOUNT, ['rx-7', 'rx-8']),
      ],
    },
  ])(
    "takes its prescription's subject, as the prescription spells it, when $name",
    ({ records }) => {
      const { dispense, onPrescription } = adoptedFill(records)
      expect(subjectOfDispense(dispense)).toEqual(onPrescription)
      expect(onPrescription).toMatchObject({
        reference: `Patient/${localResourceId(`${BASE_URL}/Patient`, 'Patient', 'pat-7')}`,
      })
    }
  )

  it.each([
    {
      name: 'its prescription is not in the set',
      records: [patient('pat-7'), dispenseOf(ACCOUNT, ['rx-7'])],
    },
    {
      name: "its prescription's subject names no Patient of the set",
      records: [patient('pat-7'), prescriptionFor('rx-7', 'pat-9'), dispenseOf(ACCOUNT, ['rx-7'])],
    },
    {
      name: 'its prescriptions name different Patients',
      records: [
        patient('pat-7'),
        patient('pat-8'),
        prescriptionFor('rx-7', 'pat-7'),
        prescriptionFor('rx-8', 'pat-8'),
        dispenseOf(ACCOUNT, ['rx-7', 'rx-8']),
      ],
    },
    {
      name: "one of its prescriptions' subject names no Patient of the set",
      records: [
        patient('pat-7'),
        prescriptionFor('rx-7', 'pat-7'),
        prescriptionFor('rx-8', 'pat-9'),
        dispenseOf(ACCOUNT, ['rx-7', 'rx-8']),
      ],
    },
  ])('keeps its own subject when $name', ({ records }) => {
    const { dispense } = adoptedFill(records)
    expect(subjectOfDispense(dispense)).toMatchObject({
      reference: null,
      type: 'Patient',
      identifier: { value: 'acct-1' },
    })
  })

  it('leaves a dispense whose subject names a Patient of the set on that Patient', () => {
    const { dispense } = adoptedFill([
      patient('pat-7'),
      patient('pat-8'),
      prescriptionFor('rx-7', 'pat-7'),
      dispenseOf({ reference: 'Patient/pat-8' }, ['rx-7']),
    ])
    expect(subjectOfDispense(dispense)).toMatchObject({
      reference: `Patient/${localResourceId(`${BASE_URL}/Patient`, 'Patient', 'pat-8')}`,
    })
  })
})

describe('DecodedFileSet.writtenReferenceTitle', () => {
  it('names a keyed record by the reference the import stage writes it under', () => {
    const [section] = DecodedFileSet.adopt({
      sections: [sectionOf('people', [patient('pat-7')])],
      notes: [],
    }).sections
    expect(section?.resources.map(({ title }) => title)).toEqual([
      `Patient/${localResourceId(`${BASE_URL}/Patient`, 'Patient', 'pat-7')}`,
    ])
  })

  it('names a keyless record by its type and its fullUrl, which a re-decode keeps', () => {
    const [section] = DecodedFileSet.adopt(
      { sections: [sectionOf('people', [patient(null)])], notes: [] },
      countingMinter()
    ).sections
    expect(section?.resources.map(({ title, resource }) => [title, resource.id])).toEqual([
      ['Patient (people:0)', 'minted-1'],
    ])
  })

  it('keys each adopted row by its entry fullUrl', () => {
    const [section] = DecodedFileSet.adopt({
      sections: [sectionOf('people', [patient('pat-7'), patient(null)])],
      notes: [],
    }).sections
    expect(section?.resources.map(({ key }) => key)).toEqual(['people:0', 'people:1'])
  })
})

describe('DecodedFileSet.namespaceKeys', () => {
  it('prefixes every fullUrl and keeps everything else', () => {
    const section = sectionOf('people', [patient('pat-7')])
    expect(DecodedFileSet.namespaceKeys([section], '0:a.har/')).toEqual([
      {
        ...section,
        entries: section.entries.map((entry) => ({
          ...entry,
          fullUrl: `0:a.har/${entry.fullUrl}`,
        })),
      },
    ])
  })
})
