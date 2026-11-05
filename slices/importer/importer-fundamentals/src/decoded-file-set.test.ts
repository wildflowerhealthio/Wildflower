import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { localResourceId } from '@wildflowerhealthio/fhir-r4/identity'
import {
  Binary,
  type FhirResourceWithId,
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

  // A keyless record's id is minted at import, so nothing names it by key.
  it('leaves a reference to a keyless record of the set logical', () => {
    const [, observation] = adoptedIn([
      sectionOf('people', [patient(null)]),
      sectionOf('results', [observationOn({ reference: 'Patient/pat-7' })]),
    ])
    expect(subjectOf(observation)).toBeNull()
  })
})

describe('DecodedFileSet.writtenReferenceTitle', () => {
  it('names a keyed record by the reference the import stage writes it under', () => {
    const [section] = DecodedFileSet.adopt({
      sections: [sectionOf('people', [patient('pat-7')])],
      notes: [],
    }).sections
    expect(section?.resources.map(({ title }) => title)).toEqual(
      section?.resources.map(({ resource }) => `Patient/${resource.id}`)
    )
  })

  it('names a keyless record by its type and its fullUrl, which a re-decode keeps', () => {
    expect(
      DecodedFileSet.writtenReferenceTitle({ fullUrl: 'har-entry-3:0', resource: patient(null) })
    ).toBe('Patient (har-entry-3:0)')
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
