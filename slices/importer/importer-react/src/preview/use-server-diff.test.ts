import { Schema } from 'effect'
import * as fc from 'fast-check'
import type { ServerComparison } from 'fhir-r4/clients'
import { type FhirResource, Patient } from 'fhir-r4/resources'
import type { BatchDecodeResult, FormatKind } from 'importer-core'
import { FormatDecode, PickedFileSource } from 'importer-fundamentals'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { byFormatAndKey, diffRowsOf, initialExclusionsFor } from './use-server-diff.ts'

/**
 * The pure folds behind the server diff: every previewed resource is probed
 * once with its format, and the verdicts come back scoped by format — so two
 * formats carrying the same resource key keep verdicts of their own.
 */

const patient = (id: string): FhirResource =>
  Schema.decodeUnknownSync(Patient.Schema)({ resourceType: 'Patient', id })

/** A format result whose one section holds one resource per `[key, id]` pair. */
const formatResult = <K extends FormatKind>(
  format: K,
  entries: readonly (readonly [string, string])[]
): FormatDecode.Result<K> => ({
  id: `${format}/test`,
  title: 'test',
  files: [{ fileName: 'test', bytes: new Uint8Array([1]), source: PickedFileSource.local }],
  format,
  decoded: {
    sections: [
      {
        title: 's',
        resources: entries.map(([key, rid]) => ({
          key,
          title: `Patient/${rid}`,
          resource: patient(rid),
        })),
      },
    ],
    notes: [],
  },
  unreadableFiles: [],
})

const makeBatch = (
  results: Partial<{ [K in FormatKind]: FormatDecode.Result<K> }>
): BatchDecodeResult => ({
  har: FormatDecode.emptyResult('har'),
  'lifelabs-pdf': FormatDecode.emptyResult('lifelabs-pdf'),
  dicom: FormatDecode.emptyResult('dicom'),
  ...results,
  unrecognizedFiles: [],
})

const UNCHANGED: ServerComparison = { status: 'unchanged', fields: [] }
const CHANGED: ServerComparison = { status: 'changed', fields: [] }

describe('diffRowsOf / byFormatAndKey', () => {
  it('should keep verdicts apart for two formats that share a resource key', () => {
    const batch = makeBatch({
      har: formatResult('har', [['patient', 'p-new']]),
      dicom: formatResult('dicom', [['patient', 'p-old']]),
    })
    const verdicts = byFormatAndKey(diffRowsOf(batch), new Map([['Patient/p-old', UNCHANGED]]))

    expect(verdicts.get('har')?.get('patient')?.status).toBe('new')
    expect(verdicts.get('dicom')?.get('patient')?.status).toBe('unchanged')
  })

  it('property: every resource of every format gets exactly its own verdict, or `new` when unclassified', () => {
    const formatArbitrary = <K extends FormatKind>(kind: K): fc.Arbitrary<FormatDecode.Result<K>> =>
      fc
        .uniqueArray(fc.stringMatching(/^[a-z]{1,3}$/u), { minLength: 1, maxLength: 4 })
        .map((keys) =>
          formatResult(
            kind,
            keys.map((key) => [key, `${kind}-${key}`] as const)
          )
        )
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
          const verdicts = byFormatAndKey(rows, classified)
          for (const row of rows) {
            expect(verdicts.get(row.format)?.get(row.key)).toEqual(
              verdictFor(row.resource.id) ?? { status: 'new', fields: [] }
            )
          }
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('initialExclusionsFor', () => {
  it('should pre-exclude exactly the unchanged keys, and nothing without verdicts', () => {
    const labeled = [
      { key: 'a', title: 'Patient/a', resource: patient('a') },
      { key: 'b', title: 'Patient/b', resource: patient('b') },
    ]
    const verdicts = new Map([
      ['a', UNCHANGED],
      ['b', CHANGED],
    ])
    expect([...initialExclusionsFor(labeled, verdicts)]).toEqual(['a'])
    expect(initialExclusionsFor(labeled, undefined).size).toBe(0)
  })
})
