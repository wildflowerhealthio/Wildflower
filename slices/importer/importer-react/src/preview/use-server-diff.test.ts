import { Schema } from 'effect'
import * as fc from 'fast-check'
import type { ServerComparison } from 'fhir-r4/clients'
import { type FhirResource, Patient } from 'fhir-r4/resources'
import type { UnitReadOutcome } from 'importer-core'
import { LOCAL_SOURCE } from 'importer-fundamentals'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { byUnitAndKey, diffRowsOf, initialExclusionsFor } from './use-server-diff.ts'

/**
 * The pure folds behind the server diff: every previewed resource is probed
 * once with its unit, and the verdicts come back scoped by unit — so two
 * units carrying the same resource key (a format whose keys name a role,
 * every format's source-file row) keep verdicts of their own.
 */

const patient = (id: string): FhirResource =>
  Schema.decodeUnknownSync(Patient.Schema)({ resourceType: 'Patient', id })

/** A read unit whose one section holds one resource per `[key, id]` pair. */
const unit = (
  unitId: string,
  entries: readonly (readonly [string, string])[]
): UnitReadOutcome => ({
  _tag: 'read',
  id: unitId,
  title: `${unitId}.dcm`,
  files: [{ fileName: `${unitId}.dcm`, bytes: new Uint8Array([1]), source: LOCAL_SOURCE }],
  format: 'dicom',
  decoded: {
    sections: [
      {
        title: 's',
        resources: entries.map(([key, id]) => ({
          key,
          title: `Patient/${id}`,
          resource: patient(id),
        })),
      },
    ],
    notes: [],
  },
})

const UNCHANGED: ServerComparison = { status: 'unchanged', fields: [] }
const CHANGED: ServerComparison = { status: 'changed', fields: [] }

describe('diffRowsOf / byUnitAndKey', () => {
  it('should keep verdicts apart for two units that share a resource key', () => {
    // Two DICOM files both label their patient `patient`; only the second is on the server.
    const units = [unit('u1', [['patient', 'p-new']]), unit('u2', [['patient', 'p-old']])]
    const verdicts = byUnitAndKey(diffRowsOf(units), new Map([['Patient/p-old', UNCHANGED]]))

    expect(verdicts.get('u1')?.get('patient')?.status).toBe('new')
    expect(verdicts.get('u2')?.get('patient')?.status).toBe('unchanged')
  })

  it('property: every resource of every read unit gets exactly its own verdict, or `new` when unclassified', () => {
    const unitArbitrary = fc
      .tuple(
        fc.uuid(),
        fc.uniqueArray(fc.stringMatching(/^[a-z]{1,3}$/u), { minLength: 1, maxLength: 4 })
      )
      .map(([id, keys]) =>
        unit(
          id,
          keys.map((key) => [key, `${id}-${key}`] as const)
        )
      )
    fc.assert(
      fc.property(
        fc.uniqueArray(unitArbitrary, { maxLength: 5, selector: (candidate) => candidate.id }),
        fc.func(fc.constantFrom(UNCHANGED, CHANGED, undefined)),
        (units, verdictFor) => {
          const rows = diffRowsOf(units)
          const classified = new Map<string, ServerComparison>()
          for (const row of rows) {
            const verdict = verdictFor(row.resource.id)
            if (verdict !== undefined) classified.set(`Patient/${row.resource.id}`, verdict)
          }
          const verdicts = byUnitAndKey(rows, classified)
          expect(rows.length).toBe(
            units.reduce(
              (n, u) =>
                n + (u._tag === 'read' ? (u.decoded.sections[0]?.resources.length ?? 0) : 0),
              0
            )
          )
          for (const row of rows) {
            expect(verdicts.get(row.unitId)?.get(row.key)).toEqual(
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
