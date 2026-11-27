import { type BatchEntryOutcome, NO_RESPONSE_STATUS } from '@wildflowerhealthio/fhir-r4/clients'
import { PlanResolution, PlanTotals } from '@wildflowerhealthio/importer-fundamentals'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Option } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import {
  completeLine,
  fileSetLine,
  importButtonLabel,
  readySentence,
  refusalMessagesOf,
  summaryTitle,
  undecidedRecordLine,
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
