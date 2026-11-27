import { type BatchEntryOutcome, NO_RESPONSE_STATUS } from '@wildflowerhealthio/fhir-r4/clients'
import {
  ExistingRecord,
  PlanResolution,
  PlanTotals,
} from '@wildflowerhealthio/importer-fundamentals'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Option } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import {
  createAllLabel,
  decidedAutomaticallyLine,
  identifierMatchTag,
  patientDetail,
  personReasonLine,
  recordGroupHeading,
  recordGroupLine,
  recordReasonLine,
  referencePart,
  referencesDetail,
  sameAsExistingLine,
  setEveryLabel,
  showMoreLabel,
  useRecordLabel,
  onImportLabel,
  completeLine,
  DecisionMatches,
  decisionMetaLine,
  dontAddOutcome,
  existingKicker,
  existingRecordOutcome,
  fileSetLine,
  importButtonLabel,
  readySentence,
  refusalMessagesOf,
  saveAsNewOutcome,
  selectRecordLead,
  selectRecordTitle,
  summaryTitle,
  undecidedRecordLine,
  updateWithImportLabel,
  writeFailureMessage,
} from './plan-text.ts'
import * as WriteFailure from './write-failure.ts'

/** Counts with `byLabel` as given, every label left out counting zero. */
const countsOf = (
  byLabel: Partial<Record<PlanResolution.Label, number>>,
  needsDecision = 0
): PlanTotals.Counts => PlanTotals.makeCounts((label) => byLabel[label] ?? 0, needsDecision)

/** What the file line says of each label, in the order it says them. */
const WORDS: readonly (readonly [PlanResolution.Label, string])[] = [
  ['Create', 'new'],
  ['Update', 'updated'],
  ['LinkToExisting', 'linked'],
  ['DontAdd', 'not added'],
  ['Unneeded', 'not needed'],
  ['Open', 'open'],
]

/** Counts of up to 200 records under each label. */
const arbitraryCounts = fc
  .array(fc.nat({ max: 200 }), {
    minLength: PlanResolution.labels.length,
    maxLength: PlanResolution.labels.length,
  })
  .map((counted) =>
    PlanTotals.makeCounts((label) => counted[PlanResolution.labels.indexOf(label)] ?? 0, 0)
  )

/** An outcome of a refused write, with the issue `texts` and `status` given. */
const refusedOutcome = (status: string, texts: readonly string[]): BatchEntryOutcome => ({
  target: { label: 'Patient/p-1', id: 'p-1' },
  status,
  ok: false,
  issues: texts.map((text) => ({ severity: 'error', code: 'processing', text })),
})

describe('summaryTitle', () => {
  it('counts records and files, singular for one', () => {
    expect([summaryTitle(1, 1), summaryTitle(47, 3), summaryTitle(0, 2)]).toEqual([
      '1 record from 1 file',
      '47 records from 3 files',
      '0 records from 2 files',
    ])
  })
})

describe('fileSetLine', () => {
  it('says every part that counts a record, in order', () => {
    expect(
      fileSetLine(
        countsOf({ Create: 12, Update: 2, LinkToExisting: 55, DontAdd: 3, Unneeded: 4, Open: 1 })
      )
    ).toBe('77 records · 12 new · 2 updated · 55 linked · 3 not added · 4 not needed · 1 open')
  })

  it('leaves out exactly the zero parts, and its parts sum to the records it counts', () => {
    fc.assert(
      fc.property(arbitraryCounts, (counts) => {
        const [records, ...parts] = fileSetLine(counts).split(' · ')
        const total = PlanTotals.recordsOf(counts)
        expect(records).toBe(`${total} ${total === 1 ? 'record' : 'records'}`)
        expect(parts).toEqual(
          WORDS.filter(([label]) => counts.byLabel[label] > 0).map(
            ([label, word]) => `${counts.byLabel[label]} ${word}`
          )
        )
        expect(parts.reduce((sum, part) => sum + Number.parseInt(part, 10), 0)).toBe(total)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })
})

describe('importButtonLabel', () => {
  it('names what is created, updated and linked, zeros included', () => {
    expect(importButtonLabel(countsOf({ Create: 47, LinkToExisting: 65 }))).toBe(
      'Import · 47 new, 0 updated, 65 linked'
    )
  })
})

describe('readySentence', () => {
  it('says how many records are not added only when any is', () => {
    expect([
      readySentence(countsOf({ Create: 3 })),
      readySentence(countsOf({ Create: 3, DontAdd: 1 })),
      readySentence(countsOf({ Create: 3, DontAdd: 4 })),
    ]).toEqual([
      'Written as one transaction: all records or none.',
      '1 record not added. Written as one transaction: all records or none.',
      '4 records not added. Written as one transaction: all records or none.',
    ])
  })
})

describe('undecidedRecordLine', () => {
  it('names the record, its type with its article, and its file', () => {
    expect([
      undecidedRecordLine({ resourceType: 'Patient', title: 'Tyra Banks', fileTitle: 'a.har' }),
      undecidedRecordLine({
        resourceType: 'Organization',
        title: 'Rexall #4012',
        fileTitle: 'rexall.har',
      }),
    ]).toEqual([
      'Select a Patient record for Tyra Banks from a.har.',
      'Select an Organization record for Rexall #4012 from rexall.har.',
    ])
  })
})

describe('selectRecordTitle', () => {
  it("is the card's lead, then the file's title", () => {
    const record = { resourceType: 'Practitioner', title: 'Dr. Brown', fileTitle: 'b.har' }

    expect([selectRecordLead(record), selectRecordTitle(record)]).toEqual([
      'Select a Practitioner record for Dr. Brown from',
      'Select a Practitioner record for Dr. Brown from b.har',
    ])
  })
})

describe('decisionMetaLine', () => {
  it('says a name match is not selected, its matches, its referrers and the fields they agree on', () => {
    expect(
      decisionMetaLine({
        isOpen: true,
        matches: DecisionMatches.NameMatches({ count: 2, sameFields: ['name', 'birthDate'] }),
        referrers: 22,
      })
    ).toBe('Not selected · 2 possible matches · referenced by 22 records · same name, birthDate')
  })

  it('counts identifier matches, with no fields agreed on', () => {
    expect([
      decisionMetaLine({
        isOpen: true,
        matches: DecisionMatches.IdentifierMatches({ count: 2 }),
        referrers: 0,
      }),
      decisionMetaLine({
        isOpen: false,
        matches: DecisionMatches.IdentifierMatches({ count: 3 }),
        referrers: 1,
      }),
    ]).toEqual([
      'Not selected · 2 identifier matches',
      '3 identifier matches · referenced by 1 record',
    ])
  })

  it('leaves out what does not apply, singular for one', () => {
    expect([
      decisionMetaLine({
        isOpen: false,
        matches: DecisionMatches.NameMatches({ count: 1, sameFields: [] }),
        referrers: 1,
      }),
      decisionMetaLine({
        isOpen: false,
        matches: DecisionMatches.NameMatches({ count: 3, sameFields: ['name'] }),
        referrers: 0,
      }),
    ]).toEqual(['1 possible match · referenced by 1 record', '3 possible matches · same name'])
  })
})

describe('existingKicker', () => {
  it('gives the parts that say when the record was updated and how well it matches, each when known', () => {
    expect([
      existingKicker({
        updatedOn: Option.some('2026-06-02'),
        knownBy: ExistingRecord.MatchedBySearch({ grade: 'probable', evidence: 'name' }),
      }),
      existingKicker({
        updatedOn: Option.none(),
        knownBy: ExistingRecord.MatchedBySearch({ grade: 'possible', evidence: 'name' }),
      }),
      existingKicker({
        updatedOn: Option.some('2025-02-11'),
        knownBy: ExistingRecord.StoredUnderDerivedId(),
      }),
      existingKicker({ updatedOn: Option.none(), knownBy: ExistingRecord.ChosenByReviewer() }),
    ]).toEqual([
      ['Existing', 'updated 2026-06-02', 'probable match'],
      ['Existing', 'possible match'],
      ['Existing', 'updated 2025-02-11'],
      ['Existing'],
    ])
  })
})

describe('saveAsNewOutcome', () => {
  it('says how many records will reference the new record, and nothing when none will', () => {
    expect([saveAsNewOutcome(22), saveAsNewOutcome(1), saveAsNewOutcome(0)]).toEqual([
      Option.some('22 records will reference the new record.'),
      Option.some('1 record will reference the new record.'),
      Option.none(),
    ])
  })
})

describe('existingRecordOutcome', () => {
  it('says how many records will reference the existing record, and how many fields it takes', () => {
    expect([
      existingRecordOutcome({ referrers: 22, fieldsUpdated: 1 }),
      existingRecordOutcome({ referrers: 1, fieldsUpdated: 2 }),
      existingRecordOutcome({ referrers: 2, fieldsUpdated: 0 }),
    ]).toEqual([
      Option.some('22 records will reference this record instead, with 1 field updated.'),
      Option.some('1 record will reference this record instead, with 2 fields updated.'),
      Option.some('2 records will reference this record instead.'),
    ])
  })

  it('says only the fields taken when no record references it, and nothing when none is taken', () => {
    expect([
      existingRecordOutcome({ referrers: 0, fieldsUpdated: 2 }),
      existingRecordOutcome({ referrers: 0, fieldsUpdated: 0 }),
    ]).toEqual([Option.some('This record will have 2 fields updated.'), Option.none()])
  })
})

describe('dontAddOutcome', () => {
  it('says how many records keep the display with no reference, and nothing when none does', () => {
    expect([
      dontAddOutcome({ referrers: 22, title: 'Tyra Banks' }),
      dontAddOutcome({ referrers: 1, title: 'Tyra Banks' }),
      dontAddOutcome({ referrers: 0, title: 'Tyra Banks' }),
    ]).toEqual([
      Option.some('22 records keep the display “Tyra Banks” with no reference'),
      Option.some('1 record keeps the display “Tyra Banks” with no reference'),
      Option.none(),
    ])
  })
})

describe('updateWithImportLabel', () => {
  it('counts the fields taken of those that differ, when more than one differs', () => {
    expect([
      updateWithImportLabel({ taken: 1, differing: 2 }),
      updateWithImportLabel({ taken: 0, differing: 3 }),
      updateWithImportLabel({ taken: 1, differing: 1 }),
    ]).toEqual([
      'Update with import details · 1 of 2',
      'Update with import details · 0 of 3',
      'Update with import details',
    ])
  })
})

describe('completeLine', () => {
  it('names what was created, updated and linked', () => {
    expect(completeLine(countsOf({ Create: 47, Update: 2, LinkToExisting: 65 }))).toBe(
      '47 new, 2 updated, 65 linked.'
    )
  })
})

describe('refusalMessagesOf', () => {
  it('says each distinct issue once, and an outcome with none by its status', () => {
    expect(
      refusalMessagesOf([
        refusedOutcome('400 Bad Request', ['Transaction failed at entry 0']),
        refusedOutcome('400 Bad Request', ['Transaction failed at entry 0', '']),
        refusedOutcome(NO_RESPONSE_STATUS, []),
      ])
    ).toEqual(['Transaction failed at entry 0', 'No response'])
  })
})

describe('writeFailureMessage', () => {
  it('says nothing was written when the transaction was refused, and that it is not known when no answer came back', () => {
    const refused = WriteFailure.fromOutcomes([refusedOutcome('400 Bad Request', ['Refused'])])
    const unanswered = WriteFailure.fromOutcomes([
      refusedOutcome('400 Bad Request', ['Refused']),
      refusedOutcome(NO_RESPONSE_STATUS, []),
    ])

    expect(
      [refused, unanswered].map((failure) => failure.pipe(Option.map(writeFailureMessage)))
    ).toEqual([
      Option.some('No records were written. The import plan is kept.'),
      Option.some(
        'No answer came back, so it is not known whether the records were written. The import plan is kept.'
      ),
    ])
  })
})

describe('decidedAutomaticallyLine', () => {
  it('counts the records, singular for one, before what decided them', () => {
    expect([decidedAutomaticallyLine(1), decidedAutomaticallyLine(47)]).toEqual([
      '1 record. Matched by identifier, or with no similar existing record. Change any; changes are listed first.',
      '47 records. Matched by identifier, or with no similar existing record. Change any; changes are listed first.',
    ])
  })
})

describe('a group’s text', () => {
  it('heads, says its labels, names its menu and its items, and pages and folds its rows', () => {
    expect([
      recordGroupHeading('MedicationRequest', 9),
      recordGroupLine(countsOf({ Create: 2, LinkToExisting: 7 })),
      setEveryLabel('MedicationRequest'),
      createAllLabel(9),
      showMoreLabel(20),
      sameAsExistingLine(12),
    ]).toEqual([
      'MedicationRequest · 9',
      '2 new · 7 linked',
      'Set every MedicationRequest',
      'Create all 9',
      'Show 20 more',
      '12 same as existing',
    ])
  })
})

describe('a row’s text', () => {
  it('names a merge into an existing record, updated when it writes to it, and the row’s choice', () => {
    expect([
      useRecordLabel({ title: 'Tyra Banks', updates: false }),
      useRecordLabel({ title: 'Tyra Banks', updates: true }),
      onImportLabel('Tyra Banks'),
    ]).toEqual(['Use Tyra Banks', 'Use Tyra Banks, updated', 'On import: Tyra Banks'])
  })

  it('tags an identifier match the same as existing, or how many fields differ', () => {
    expect([0, 1, 3].map(identifierMatchTag)).toEqual([
      'Identifier match · same as existing',
      'Identifier match · 1 field differs',
      'Identifier match · 3 fields differ',
    ])
  })

  it('says a record’s tag, a person’s file and referrers, and when either is not needed', () => {
    expect([
      recordReasonLine({ tag: 'New · no match', isUnneeded: false }),
      recordReasonLine({ tag: 'New · no match', isUnneeded: true }),
      personReasonLine({
        fileTitle: 'a.har',
        tag: 'New · no match',
        referrers: 22,
        isUnneeded: false,
      }),
      personReasonLine({
        fileTitle: 'a.har',
        tag: 'New · no match',
        referrers: 0,
        isUnneeded: true,
      }),
    ]).toEqual([
      'New · no match',
      'New · no match · Not written: no record written references it',
      'a.har · New · no match · referenced by 22 records',
      'a.har · New · no match · Not written: no record written references it',
    ])
  })

  it('says a Patient’s birthDate and gender, and when it states no birthDate', () => {
    expect([
      patientDetail({ birthDate: Option.some('1990-01-02'), gender: Option.some('female') }),
      patientDetail({ birthDate: Option.some('1990-01-02'), gender: Option.none() }),
      patientDetail({ birthDate: Option.none(), gender: Option.some('female') }),
    ]).toEqual(['1990-01-02 · female', '1990-01-02', 'No birthDate · female'])
  })

  it('says each reference by its field, display only when it names nothing, and when there is none', () => {
    expect([
      referencesDetail([
        referencePart({ field: 'subject', display: 'Tyra Banks', isDisplayOnly: false }),
        referencePart({ field: 'requester', display: 'Dr. Brown', isDisplayOnly: true }),
      ]),
      referencesDetail([]),
    ]).toEqual(['subject: Tyra Banks · requester: Dr. Brown (display only)', 'No references'])
  })
})
