import { withMandatoryId } from '@wildflowerhealthio/fhir-r4/data-types'
import {
  type FhirResourceWithId,
  MedicationRequest,
  Patient,
  Practitioner,
} from '@wildflowerhealthio/fhir-r4/resources'
import {
  type LinkableResource,
  type DecodedFile,
  LinkChoice,
  LinkPlan,
  Referent,
  type ReferentLinkChoices,
} from '@wildflowerhealthio/importer-fundamentals'
import { Effect, HashMap, Schema, TestContext } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import * as MentionLinkOptions from './mention-link-options.ts'

/**
 * What a mention select offers under the referents' link targets: each record
 * a referent lands on, once, and the mention link choice picking it makes.
 */

const SOURCE = 'https://source.example/patient-id'
const CUSTOMER = 'https://source.example/customer-id'
const DEVICE = 'https://device.example/id'
const nameKey = (name: string): string =>
  `Practitioner|${Practitioner.NAME_IDENTIFIER_SYSTEM}|${name}`

const runOnTestClock = <A, E>(effect: Effect.Effect<A, E>): A =>
  Effect.runSync(Effect.provide(effect, TestContext.TestContext))

const decodePatient = Schema.decodeUnknownSync(withMandatoryId(Patient.Schema))
const decodeRequest = Schema.decodeUnknownSync(withMandatoryId(MedicationRequest.Schema))

const prescribedBy = (id: string, name: string, subject: object): FhirResourceWithId =>
  decodeRequest({
    resourceType: 'MedicationRequest',
    id,
    status: 'active',
    intent: 'order',
    subject,
    requester: {
      type: 'Practitioner',
      identifier: { system: Practitioner.NAME_IDENTIFIER_SYSTEM, value: name },
      display: name,
    },
  })

const STORED_JAN: LinkableResource.WithId = decodePatient({
  resourceType: 'Patient',
  id: 's-2',
  identifier: [{ system: DEVICE, value: 's-2' }],
  name: [{ family: 'Doe', given: ['Jan'] }],
})

const file: DecodedFile.DecodedFile = {
  sections: [
    {
      title: 'Resources',
      resources: [
        decodePatient({
          resourceType: 'Patient',
          id: 'p-1',
          identifier: [{ system: SOURCE, value: 'p-1' }],
          name: [{ family: 'Banks', given: ['Tyra'] }],
          birthDate: '1990-01-02',
        }),
        prescribedBy('rx-1', 'Dr. B Jones', {
          type: 'Patient',
          identifier: { system: CUSTOMER, value: 'c-9' },
        }),
        prescribedBy('rx-2', 'Dr. A Smith', { reference: 'Patient/p-1' }),
      ].map((resource, index) => ({ key: `k-${index}`, title: '', resource })),
    },
  ],
  notes: [],
}

/** The options under `linkChoices`, off the plan's links, on the test clock. */
const optionsUnder = (linkChoices: ReferentLinkChoices.Type): MentionLinkOptions.Type =>
  runOnTestClock(
    Effect.gen(function* () {
      const referents = yield* Referent.discover([file])
      const plan = yield* LinkPlan.make([file], linkChoices)
      return yield* MentionLinkOptions.fromLinkTargets(referents, plan.linkTargetsByReferentKey)
    })
  )

describe('MentionLinkOptions.fromLinkTargets', () => {
  it('offers a decoded or provisional record as the choice of the referent whose record it is, and a stored one as LinkToStoredResource', () => {
    const options = optionsUnder(
      HashMap.make(
        [`Patient|${CUSTOMER}|c-9`, LinkChoice.LinkToStoredResource({ resource: STORED_JAN })],
        [nameKey('Dr. A Smith'), LinkChoice.CreateResource()],
        [
          nameKey('Dr. B Jones'),
          LinkChoice.LinkToDecodedReferent({ referentKey: nameKey('Dr. A Smith') }),
        ]
      )
    )

    expect(
      MentionLinkOptions.forType(options, 'Patient').map(({ label, choice }) => [label, choice])
    ).toEqual([
      [
        'Tyra Banks · 1990-01-02',
        LinkChoice.LinkToDecodedReferent({ referentKey: `Patient|${SOURCE}|p-1` }),
      ],
      ['Jan Doe', LinkChoice.LinkToStoredResource({ resource: STORED_JAN })],
    ])
    // Two referents land on one provisional record: picking it is the choice
    // of the name it stands for, not of the referent merely linked to it.
    expect(
      MentionLinkOptions.forType(options, 'Practitioner').map(({ label, choice }) => [
        label,
        choice,
      ])
    ).toEqual([
      ['Dr. A Smith', LinkChoice.LinkToDecodedReferent({ referentKey: nameKey('Dr. A Smith') })],
    ])
    expect([...options.labelsByLiteralReference.keys()]).toEqual([
      'Patient/p-1',
      'Patient/s-2',
      expect.stringMatching(/^Practitioner\//),
    ])
  })

  it('offers nothing for a referent left unlinked, and nothing at all with no referent', () => {
    const options = optionsUnder(HashMap.empty())

    expect(MentionLinkOptions.forType(options, 'Practitioner')).toEqual([])
    expect(MentionLinkOptions.forType(options, 'Patient').map(({ value }) => value)).toEqual([
      `decoded:Patient|${SOURCE}|p-1`,
    ])
    expect(
      runOnTestClock(MentionLinkOptions.fromLinkTargets([], HashMap.empty()))
        .labelsByLiteralReference.size
    ).toBe(0)
  })
})
