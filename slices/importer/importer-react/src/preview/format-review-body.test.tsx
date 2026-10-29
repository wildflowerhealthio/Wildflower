import { cleanup, render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { withMandatoryId } from '@wildflowerhealthio/fhir-r4/data-types'
import {
  type FhirResourceWithId,
  Observation,
  Patient,
} from '@wildflowerhealthio/fhir-r4/resources'
import {
  type DecodedFile,
  FileResolution,
  FormatDecode,
  LinkChoice,
  type LinkableResource,
  LinkPlan,
  Mention,
  MentionLinkChoiceSet,
  Referent,
  type ReferentLinkChoiceSet,
  StagedImport,
  UnlinkedMention,
} from '@wildflowerhealthio/importer-fundamentals'
import { Effect, HashMap, Option, Schema, TestContext } from 'effect'
import { type JSX, useMemo, useState } from 'react'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import * as MentionLinkOptions from '../identity/mention-link-options.ts'
import { DONT_LINK_LABEL } from '../identity/referent-text.ts'
import { FormatReviewBody } from './format-review-body.tsx'
import {
  NAMES_NO_PATIENT,
  NAMES_UNLINKED_ACCOUNT,
  NEEDS_A_PATIENT_HEADING,
} from './preview-text.ts'
import { keysNeedingPatient } from './unlinked-mentions.ts'

/**
 * One format's review body over a file resolved on the identity map: the Needs
 * a patient group, and the per-resource mention selects whose picks are
 * mention link choices the resolution lands.
 */

afterEach(cleanup)

const SOURCE = 'https://source.example/patient-id'
const CUSTOMER = 'https://source.example/customer-id'
const TYRA = 'Tyra Banks · 1990-01-02'
const NAOMI = 'Naomi Campbell · 1970-05-22'
const TYRA_KEY = `Patient|${SOURCE}|p-1`

const decodePatient = Schema.decodeUnknownSync(withMandatoryId(Patient.Schema))
const decodeObservation = Schema.decodeUnknownSync(withMandatoryId(Observation.Schema))

const TYRA_PATIENT: FhirResourceWithId = decodePatient({
  resourceType: 'Patient',
  id: 'p-1',
  identifier: [{ system: SOURCE, value: 'p-1' }],
  name: [{ family: 'Banks', given: ['Tyra'] }],
  birthDate: '1990-01-02',
})

const NAOMI_PATIENT: FhirResourceWithId = decodePatient({
  resourceType: 'Patient',
  id: 'p-2',
  identifier: [{ system: SOURCE, value: 'p-2' }],
  name: [{ family: 'Campbell', given: ['Naomi'] }],
  birthDate: '1970-05-22',
})

/** A weight observation about `subject`, or about no one. */
const weight = (id: string, subject?: object): FhirResourceWithId =>
  decodeObservation({
    resourceType: 'Observation',
    id,
    status: 'final',
    code: { text: `Weight ${id}` },
    ...(subject === undefined ? {} : { subject }),
  })

/** One section of `resources`, keyed `k-<index>`. */
const fileOf = (resources: readonly FhirResourceWithId[]): DecodedFile.DecodedFile => ({
  sections: [
    {
      title: 'Resources',
      resources: resources.map((resource, index) => ({
        key: `k-${index}`,
        title: `${resource.resourceType}/${resource.id}`,
        resource,
      })),
    },
  ],
  notes: [],
})

/** Tyra as the device already holds her. */
const STORED_TYRA: LinkableResource.WithId = decodePatient({
  resourceType: 'Patient',
  id: 's-1',
  identifier: [{ system: 'https://device.example/id', value: 's-1' }],
  name: [{ family: 'Banks', given: ['Tyra'] }],
  birthDate: '1990-01-02',
})

const runOnTestClock = <A, E>(effect: Effect.Effect<A, E>): A =>
  Effect.runSync(Effect.provide(effect, TestContext.TestContext))

/** A file resolved as `importer-core`'s `resolveMentions` resolves one format: the resolved file, what the referent choices leave unlinked, and the options. */
const resolvedOn = (
  file: DecodedFile.DecodedFile,
  linkChoices: ReferentLinkChoiceSet.Type,
  byMention: MentionLinkChoiceSet.Type
): {
  readonly resolved: DecodedFile.DecodedFile
  readonly unlinked: readonly UnlinkedMention.Type[]
  readonly options: MentionLinkOptions.Type
} =>
  runOnTestClock(
    Effect.gen(function* () {
      const referents = yield* Referent.discover([file])
      const planOnReferents = yield* LinkPlan.make([file], linkChoices)
      const plan = LinkPlan.withMentionLinkChoiceSet(planOnReferents, byMention)
      return {
        resolved: FileResolution.resolveFile(plan)(file),
        unlinked: UnlinkedMention.collect(FileResolution.resolveFile(planOnReferents)(file)),
        options: yield* MentionLinkOptions.fromLinkTargets(
          referents,
          plan.linkTargetsByReferentKey
        ),
      }
    })
  )

/** What the harness reports after every change: the selection, the mention link choices and the resolved file. */
interface Reported {
  readonly selection: StagedImport.Selection
  readonly byMention: MentionLinkChoiceSet.Type
  readonly resolved: DecodedFile.DecodedFile
}

/**
 * The review body over `resources` resolved on `choices` and the mention
 * link choices it holds, as the screen does: the selection seeded as the
 * screen seeds it, an edit override on `editedKey` when given. Reports every
 * change.
 */
const Harness = ({
  resources,
  choices = HashMap.empty(),
  editedKey,
  onReport,
}: {
  readonly resources: readonly FhirResourceWithId[]
  readonly choices?: ReferentLinkChoiceSet.Type
  readonly editedKey?: string
  readonly onReport: (reported: Reported) => void
}): JSX.Element => {
  const file = useMemo(() => fileOf(resources), [resources])
  const [byMention, setByMention] = useState<MentionLinkChoiceSet.Type>(MentionLinkChoiceSet.empty)
  const { resolved, unlinked, options } = useMemo(
    () => resolvedOn(file, choices, byMention),
    [file, choices, byMention]
  )
  const [selection, setSelection] = useState<StagedImport.Selection>(() => {
    const seeded = StagedImport.setResourcesIncluded(
      StagedImport.initial(),
      keysNeedingPatient(unlinked),
      false
    )
    const edited = resources.find((_, index) => `k-${index}` === editedKey)
    return edited === undefined || editedKey === undefined
      ? seeded
      : StagedImport.edit(seeded, editedKey, { ...edited, id: `${edited.id}-edited` })
  })
  onReport({ selection, byMention, resolved })
  return (
    <FormatReviewBody
      result={{ ...FormatDecode.emptyResult('har'), decoded: resolved }}
      selection={selection}
      comparisons={undefined}
      mentionLinkOptions={options}
      unlinked={unlinked}
      onSelectionChange={setSelection}
      onEditResource={() => undefined}
      onChooseMention={(reviewKey, mentionPath, choice) => {
        setByMention((previous) =>
          MentionLinkChoiceSet.set(previous, reviewKey, mentionPath, choice)
        )
      }}
    />
  )
}

/** The literal reference the subject of the resource keyed `key` carries in `file`, or `None` for none. */
const subjectLiteral = (file: DecodedFile.DecodedFile, key: string): Option.Option<string> =>
  Option.fromNullable(
    file.sections.flatMap((section) => section.resources).find((entry) => entry.key === key)
  ).pipe(
    Option.flatMap(({ resource }) => Mention.at(resource, Mention.SUBJECT_PATH)),
    Option.flatMapNullable(({ reference }) => reference.reference)
  )

/** A sink for the harness's reports, read through `latest`. */
const reports = (): {
  readonly latest: () => Reported
  readonly onReport: (reported: Reported) => void
} => {
  let last: Reported | undefined
  return {
    latest: () => {
      if (last === undefined) throw new Error('the harness has not rendered')
      return last
    },
    onReport: (reported) => {
      last = reported
    },
  }
}

const SUBJECT_OF_O1 = 'Patient of Observation Weight o-1'

describe('FormatReviewBody', () => {
  it('lists nothing as needing a patient when every subject is linked', () => {
    render(
      <Harness
        resources={[TYRA_PATIENT, weight('o-1', { reference: 'Patient/p-1' })]}
        onReport={() => undefined}
      />
    )

    expect(screen.queryByRole('region', { name: NEEDS_A_PATIENT_HEADING })).toBeNull()
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: SUBJECT_OF_O1 }).value).toBe(
      `decoded:${TYRA_KEY}`
    )
  })

  it('lists each resource with an unlinked subject, with why, left out until assigned', () => {
    render(
      <Harness
        resources={[
          TYRA_PATIENT,
          weight('o-1'),
          weight('o-2', { type: 'Patient', identifier: { system: CUSTOMER, value: 'c-9' } }),
        ]}
        onReport={() => undefined}
      />
    )

    const group = screen.getByRole('region', { name: NEEDS_A_PATIENT_HEADING })
    const rows = within(group).getAllByRole('listitem')
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining(NAMES_NO_PATIENT),
      expect.stringContaining(NAMES_UNLINKED_ACCOUNT),
    ])
    for (const box of within(group).getAllByRole<HTMLInputElement>('checkbox')) {
      expect(box.checked).toBe(false)
    }
  })

  it('holds a pick as a mention link choice that includes the row; Don’t link leaves it out again', async () => {
    const reported = reports()
    render(<Harness resources={[TYRA_PATIENT, weight('o-1')]} onReport={reported.onReport} />)
    const group = screen.getByRole('region', { name: NEEDS_A_PATIENT_HEADING })
    const subject = within(group).getByRole<HTMLSelectElement>('combobox', {
      name: SUBJECT_OF_O1,
    })
    expect(subject.value).toBe('dont-link')

    // Act — assign Tyra
    await userEvent.selectOptions(subject, TYRA)

    // Assert — a choice the resolution lands, the row in, kept in the group, not edited
    expect(HashMap.toEntries(reported.latest().byMention)).toEqual([
      [
        MentionLinkChoiceSet.key('k-1', Mention.SUBJECT_PATH),
        LinkChoice.LinkToDecodedReferent({ referentKey: TYRA_KEY }),
      ],
    ])
    expect(subjectLiteral(reported.latest().resolved, 'k-1')).toEqual(Option.some('Patient/p-1'))
    expect(StagedImport.isResourceIncluded(reported.latest().selection, 'k-1')).toBe(true)
    expect(StagedImport.isResourceEdited(reported.latest().selection, 'k-1')).toBe(false)
    expect(within(group).queryByText('Edited')).toBeNull()
    expect(within(group).queryByText(NAMES_NO_PATIENT)).toBeNull()
    expect(subject.value).toBe(`decoded:${TYRA_KEY}`)

    // Act — Don't link
    await userEvent.selectOptions(subject, DONT_LINK_LABEL)

    // Assert — the mention is unlinked again and the row is left out again
    expect(StagedImport.isResourceIncluded(reported.latest().selection, 'k-1')).toBe(false)
    expect(subject.value).toBe('dont-link')
    expect(within(group).getByText(NAMES_NO_PATIENT)).toBeDefined()
  })

  it('lands a pick on another person and back', async () => {
    const reported = reports()
    render(
      <Harness
        resources={[
          TYRA_PATIENT,
          NAOMI_PATIENT,
          weight('o-1', { reference: 'Patient/p-1', display: 'T. Banks' }),
        ]}
        onReport={reported.onReport}
      />
    )
    const subject = screen.getByRole<HTMLSelectElement>('combobox', { name: SUBJECT_OF_O1 })

    await userEvent.selectOptions(subject, NAOMI)
    expect(subjectLiteral(reported.latest().resolved, 'k-2')).toEqual(Option.some('Patient/p-2'))
    await userEvent.selectOptions(subject, TYRA)

    expect(subjectLiteral(reported.latest().resolved, 'k-2')).toEqual(Option.some('Patient/p-1'))
    expect(screen.queryByText('Edited')).toBeNull()
  })

  it('follows the referent a subject was picked onto when that referent is later linked', async () => {
    const reported = reports()
    const resources = [TYRA_PATIENT, weight('o-1')]
    const { rerender } = render(<Harness resources={resources} onReport={reported.onReport} />)
    const group = screen.getByRole('region', { name: NEEDS_A_PATIENT_HEADING })
    await userEvent.selectOptions(
      within(group).getByRole('combobox', { name: SUBJECT_OF_O1 }),
      TYRA
    )

    // Act — link Tyra's referent to the stored Tyra
    rerender(
      <Harness
        resources={resources}
        choices={HashMap.make([
          TYRA_KEY,
          LinkChoice.LinkToStoredResource({ resource: STORED_TYRA }),
        ])}
        onReport={reported.onReport}
      />
    )

    // Assert — the picked subject lands on the stored record, not the source one
    expect(subjectLiteral(reported.latest().resolved, 'k-1')).toEqual(Option.some('Patient/s-1'))
    expect(
      screen
        .getAllByRole<HTMLSelectElement>('combobox', { name: SUBJECT_OF_O1 })
        .map((select) => select.value)
    ).toEqual(['stored:Patient/s-1', 'stored:Patient/s-1'])
  })

  it("offers Don't link only where the mention keeps something to name", () => {
    render(
      <Harness
        resources={[
          TYRA_PATIENT,
          weight('o-1', { reference: 'Patient/p-1' }),
          weight('o-2', { reference: 'Patient/p-1', display: 'T. Banks' }),
        ]}
        onReport={() => undefined}
      />
    )
    const optionsOf = (name: string): readonly string[] =>
      within(screen.getByRole('combobox', { name }))
        .getAllByRole('option')
        .map((option) => option.textContent ?? '')

    expect(optionsOf(SUBJECT_OF_O1)).toEqual([TYRA])
    expect(optionsOf('Patient of Observation Weight o-2')).toEqual([TYRA, DONT_LINK_LABEL])
  })

  it('relinks a row’s edit override at the mention picked, since the override is what gets written', async () => {
    const reported = reports()
    render(
      <Harness
        resources={[TYRA_PATIENT, weight('o-1')]}
        editedKey="k-1"
        onReport={reported.onReport}
      />
    )
    // Listed under Needs a patient and in its section: either select will do.
    const [subject] = screen.getAllByRole<HTMLSelectElement>('combobox', { name: SUBJECT_OF_O1 })
    if (subject === undefined) throw new Error('unreachable: the row has a subject select')

    await userEvent.selectOptions(subject, TYRA)

    const override = StagedImport.editedResource(reported.latest().selection, 'k-1')
    expect(Option.map(override, ({ id }) => id)).toEqual(Option.some('o-1-edited'))
    expect(
      Option.flatMap(override, (edited) => Mention.at(edited, Mention.SUBJECT_PATH)).pipe(
        Option.flatMapNullable(({ reference }) => reference.reference)
      )
    ).toEqual(Option.some('Patient/p-1'))
    expect(screen.getAllByText('Edited')).toHaveLength(2)
  })
})
