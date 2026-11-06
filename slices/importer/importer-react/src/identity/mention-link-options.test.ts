import { withMandatoryId } from '@wildflowerhealthio/fhir-r4/data-types'
import { MedicationRequest, Patient, Practitioner } from '@wildflowerhealthio/fhir-r4/resources'
import {
  type LinkableResource,
  type DecodedFile,
  LinkChoice,
  LinkPlan,
  type ReferentLinkChoiceSet,
  SectionedList,
} from '@wildflowerhealthio/importer-fundamentals'
import { Effect, HashMap, Schema, TestContext } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import * as MentionLinkOptions from './mention-link-options.ts'

/**
 * What a mention select offers: exactly the plan's resolved resources, once
 * each, and the mention link choice picking each makes.
 */

const SOURCE = 'https://source.example/patient-id'
const NAME = 'https://source.example/practitioner-name'
const DEVICE = 'https://device.example/id'
const PERSON = JSON.stringify(['Patient', SOURCE, 'p-1'])
const OTHER_PERSON = JSON.stringify(['Patient', SOURCE, 'p-2'])
const PRESCRIBER = JSON.stringify(['Practitioner', NAME, 'Dr. A Smith'])

const runOnTestClock = <A, E>(effect: Effect.Effect<A, E>): A =>
  Effect.runSync(Effect.provide(effect, TestContext.TestContext))

const decodePatient = Schema.decodeUnknownSync(withMandatoryId(Patient.Schema))
const decodeRequest = Schema.decodeUnknownSync(withMandatoryId(MedicationRequest.Schema))
const decodePractitioner = Schema.decodeUnknownSync(withMandatoryId(Practitioner.Schema))

const patientOf = (id: string, family: string): LinkableResource.WithId =>
  decodePatient({
    resourceType: 'Patient',
    id,
    identifier: [{ system: SOURCE, value: id }],
    name: [{ family, given: ['Tyra'] }],
    birthDate: '1990-01-02',
  })

/** The Practitioner the import implied for the printed name `Dr. A Smith`. */
const SMITH: LinkableResource.WithId = decodePractitioner({
  resourceType: 'Practitioner',
  id: 'dr-smith',
  identifier: [{ system: NAME, value: 'Dr. A Smith' }],
  name: [{ text: 'Dr. A Smith' }],
})

const STORED_JAN: LinkableResource.WithId = decodePatient({
  resourceType: 'Patient',
  id: 's-2',
  identifier: [{ system: DEVICE, value: 's-2' }],
  name: [{ family: 'Doe', given: ['Jan'] }],
})

const file: DecodedFile.DecodedFile = {
  rows: SectionedList.make([
    {
      title: 'Resources',
      rows: [
        patientOf('p-1', 'Banks'),
        patientOf('p-2', 'Bankes'),
        SMITH,
        decodeRequest({
          resourceType: 'MedicationRequest',
          id: 'rx-1',
          status: 'active',
          intent: 'order',
          subject: { reference: 'Patient/p-1' },
          requester: { reference: 'Practitioner/dr-smith', display: 'Dr. A Smith' },
        }),
      ].map((resource, index) => ({ key: `k-${index}`, title: '', resource, origin: 'Decoded' })),
    },
  ]),
  notes: [],
}

/** The options under `linkChoices`, off the plan, on the test clock. */
const optionsUnder = (linkChoices: ReferentLinkChoiceSet.Type): MentionLinkOptions.Type =>
  MentionLinkOptions.fromPlan(runOnTestClock(LinkPlan.make([file], linkChoices)))

/** Each option for `type` as `[label, value]`. */
const labelsAndValuesFor = (
  options: MentionLinkOptions.Type,
  type: 'Patient' | 'Practitioner'
): readonly (readonly [string, string])[] =>
  MentionLinkOptions.forType(options, type).map(({ label, value }) => [label, value] as const)

describe('MentionLinkOptions.fromPlan', () => {
  it('offers a decoded record as the choice of the referent whose record it is, and a stored one as LinkToStoredResource', () => {
    const options = optionsUnder(
      HashMap.make([OTHER_PERSON, LinkChoice.LinkToStoredResource({ resource: STORED_JAN })])
    )

    expect(labelsAndValuesFor(options, 'Patient')).toEqual([
      ['Tyra Banks · 1990-01-02', `decoded:${PERSON}`],
      ['Jan Doe', 'stored:Patient/s-2'],
    ])
    expect(MentionLinkOptions.forType(options, 'Patient').map(({ choice }) => choice._tag)).toEqual(
      ['LinkToDecodedReferent', 'LinkToStoredResource']
    )
    expect(labelsAndValuesFor(options, 'Practitioner')).toEqual([
      ['Dr. A Smith', `decoded:${PRESCRIBER}`],
    ])
    expect([...options.labelsByLiteralReference.keys()]).toEqual([
      'Patient/p-1',
      'Patient/s-2',
      'Practitioner/dr-smith',
    ])
  })

  it('offers a stored record two referents are linked to once', () => {
    const options = optionsUnder(
      HashMap.make(
        [PERSON, LinkChoice.LinkToStoredResource({ resource: STORED_JAN })],
        [OTHER_PERSON, LinkChoice.LinkToStoredResource({ resource: STORED_JAN })]
      )
    )

    // The stored record as the plan links it, carrying both referents' identifiers.
    expect(
      MentionLinkOptions.forType(options, 'Patient').map(({ label, value }) => [label, value])
    ).toEqual([['Jan Doe', 'stored:Patient/s-2']])
  })

  it('offers a record written over its stored copy as the choice of its referent', () => {
    const options = optionsUnder(
      HashMap.make([PRESCRIBER, LinkChoice.UpdateStoredResource({ resource: SMITH })])
    )

    expect(
      MentionLinkOptions.forType(options, 'Practitioner').map(({ value, choice }) => [
        value,
        choice,
      ])
    ).toEqual([
      [`decoded:${PRESCRIBER}`, LinkChoice.LinkToDecodedReferent({ referentKey: PRESCRIBER })],
    ])
  })

  it('offers nothing at all with no referent', () => {
    expect(MentionLinkOptions.fromPlan(LinkPlan.empty)).toEqual(MentionLinkOptions.empty)
  })
})
