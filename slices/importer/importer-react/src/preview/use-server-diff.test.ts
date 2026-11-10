import type { ServerComparison } from '@wildflowerhealthio/fhir-r4/clients'
import { withMandatoryId } from '@wildflowerhealthio/fhir-r4/data-types'
import { type FhirResourceWithId, Patient } from '@wildflowerhealthio/fhir-r4/resources'
import { type FormatKind, type ResolvedBatch, ReviewGroup } from '@wildflowerhealthio/importer-core'
import { LinkPlan, SectionedList } from '@wildflowerhealthio/importer-fundamentals'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { byGroupAndKey, diffRowsOf, unchangedKeysOf } from './use-server-diff.ts'

/**
 * The pure folds behind the server diff: every previewed resource is probed
 * once with its group, and the verdicts come back scoped by group — so two
 * formats carrying the same resource key keep verdicts of their own, and the
 * batch's linked records, no format's, keep theirs.
 */

const patient = (id: string): FhirResourceWithId =>
  Schema.decodeUnknownSync(withMandatoryId(Patient.Schema))({ resourceType: 'Patient', id })

/** A format's group of one pick whose one section holds one resource per `[key, id]` pair. */
const formatGroup = (entries: readonly (readonly [string, string])[]): ReviewGroup.Type => ({
  sectionedList: SectionedList.make([
    {
      title: 's',
      rows: entries.map(([key, rid]) => ({
        reviewKey: key,
        title: `Patient/${rid}`,
        isImplied: false,
        resource: patient(rid),
      })),
    },
  ]),
  notes: [],
  unreadableFiles: [],
  files: [{ id: '0:test', fileName: 'test', bytes: new Uint8Array([1]) }],
})

const makeBatch = (groups: ReviewGroup.Groups<FormatKind>): ResolvedBatch => ({
  groups,
  plan: LinkPlan.empty,
  decoded: { groups, unrecognizedFiles: [] },
})

const UNCHANGED: ServerComparison = { status: 'unchanged', fields: [] }
const CHANGED: ServerComparison = { status: 'changed', fields: [] }

describe('diffRowsOf / byGroupAndKey', () => {
  it('should probe the linked records under their own group, after the formats', () => {
    const formats = makeBatch({ har: formatGroup([['patient', 'p-har']]) })
    const batch: ResolvedBatch = {
      ...formats,
      groups: {
        ...formats.groups,
        linked: ReviewGroup.linked([
          {
            reviewKey: 'linked:Patient/p-stored',
            title: 'Patient/p-stored',
            isImplied: false,
            resource: patient('p-stored'),
          },
        ]),
      },
    }
    const rows = diffRowsOf(batch)
    const verdicts = byGroupAndKey(rows, new Map([['Patient/p-stored', CHANGED]]))

    expect(rows.map((row) => [row.group, row.key])).toEqual([
      ['har', 'patient'],
      [ReviewGroup.LINKED, 'linked:Patient/p-stored'],
    ])
    expect(verdicts.get(ReviewGroup.LINKED)?.get('linked:Patient/p-stored')).toBe(CHANGED)
    expect(verdicts.get('har')?.get('patient')?.status).toBe('new')
  })

  it('should keep verdicts apart for two formats that share a resource key', () => {
    const batch = makeBatch({
      har: formatGroup([['patient', 'p-new']]),
      dicom: formatGroup([['patient', 'p-old']]),
    })
    const verdicts = byGroupAndKey(diffRowsOf(batch), new Map([['Patient/p-old', UNCHANGED]]))

    expect(verdicts.get('har')?.get('patient')?.status).toBe('new')
    expect(verdicts.get('dicom')?.get('patient')?.status).toBe('unchanged')
  })

  it('property: every resource of every format gets exactly its own verdict, or `new` when unclassified', () => {
    const formatArbitrary = (kind: FormatKind): fc.Arbitrary<ReviewGroup.Type> =>
      fc
        .uniqueArray(fc.stringMatching(/^[a-z]{1,3}$/u), { minLength: 1, maxLength: 4 })
        .map((keys) => formatGroup(keys.map((key) => [key, `${kind}-${key}`] as const)))
    fc.assert(
      fc.property(
        formatArbitrary('har'),
        formatArbitrary('dicom'),
        fc.func(fc.constantFrom(UNCHANGED, CHANGED, undefined)),
        (har, dicom, verdictFor) => {
          const batch = makeBatch({ har, dicom })
          const rows = diffRowsOf(batch)
          const classified = new Map<string, ServerComparison>()
          for (const row of rows) {
            const verdict = verdictFor(row.resource.id)
            if (verdict !== undefined) classified.set(`Patient/${row.resource.id}`, verdict)
          }
          const verdicts = byGroupAndKey(rows, classified)
          for (const row of rows) {
            expect(verdicts.get(row.group)?.get(row.key)).toEqual(
              verdictFor(row.resource.id) ?? { status: 'new', fields: [] }
            )
          }
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('unchangedKeysOf', () => {
  it('should find exactly the unchanged keys, and nothing without verdicts', () => {
    const labeled = [
      {
        reviewKey: 'a',
        title: 'Patient/a',
        isImplied: false,
        resource: patient('a'),
      },
      {
        reviewKey: 'b',
        title: 'Patient/b',
        isImplied: false,
        resource: patient('b'),
      },
    ]
    const verdicts = new Map([
      ['a', UNCHANGED],
      ['b', CHANGED],
    ])
    expect(unchangedKeysOf(labeled, verdicts)).toEqual(new Set(['a']))
    expect(unchangedKeysOf(labeled, undefined)).toEqual(new Set())
  })
})
