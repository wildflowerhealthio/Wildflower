import { Either, Schema } from 'effect'
import * as fc from 'fast-check'
import { type FhirResource, Patient } from 'fhir-r4/resources'
import { PickedFileSource, StagedImport } from 'importer-fundamentals'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { planUnitWrite } from './plan-write.ts'
import type { BatchEntry } from './read-batch.ts'
import { UnrecognizedFile } from './read-batch.ts'

const resource = (id: string): FhirResource =>
  Schema.decodeUnknownSync(Patient.Schema)({ resourceType: 'Patient', id })

const readUnit = (keys: readonly string[]): BatchEntry =>
  Either.right({
    id: 'u',
    title: 'a.har',
    files: [{ fileName: 'a.har', bytes: new Uint8Array([1]), source: PickedFileSource.local }],
    format: 'har',
    decoded: {
      sections: [
        {
          title: 's',
          resources: keys.map((key) => ({ key, title: key, resource: resource(key) })),
        },
      ],
      notes: [],
    },
  })

describe('planUnitWrite', () => {
  it('should skip an unreadable or unrecognized unit as unreadable', () => {
    const files = [{ fileName: 'x', bytes: new Uint8Array(), source: PickedFileSource.local }]
    expect(
      planUnitWrite(
        Either.left(new UnrecognizedFile({ id: 'u', title: 'x', files })),
        StagedImport.initial()
      )
    ).toEqual({ _tag: 'skip', reason: 'unreadable' })
  })

  it('property: writes exactly the included resources in review order, edits substituted, excluded counted', () => {
    const keysArbitrary = fc.uniqueArray(fc.stringMatching(/^[a-z]{1,4}$/u), { maxLength: 6 })
    fc.assert(
      fc.property(
        keysArbitrary,
        fc.func(fc.boolean()),
        fc.func(fc.boolean()),
        (keys, excludes, edits) => {
          let selection = StagedImport.initial<FhirResource>()
          for (const key of keys) {
            if (excludes(key)) selection = StagedImport.toggleResource(selection, key)
            if (edits(key)) selection = StagedImport.edit(selection, key, resource(`${key}-edited`))
          }
          const plan = planUnitWrite(readUnit(keys), selection)
          const included = keys.filter((key) => !excludes(key))
          if (included.length === 0) {
            expect(plan).toEqual({ _tag: 'skip', reason: 'nothing' })
            return
          }
          if (plan._tag !== 'write') throw new Error('expected a write')
          expect(plan.resources.map((entry) => entry.id)).toEqual(
            included.map((key) => (edits(key) ? `${key}-edited` : key))
          )
          expect(plan.excluded).toBe(keys.length - included.length)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
