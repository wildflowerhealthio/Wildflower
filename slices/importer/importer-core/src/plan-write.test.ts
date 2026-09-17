import { ParseResult, Schema } from 'effect'
import * as fc from 'fast-check'
import { type FhirResource, Patient } from 'fhir-r4/resources'
import { type FormatDecode, PickedFileSource, StagedImport } from 'importer-fundamentals'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { planFormatWrite } from './plan-write.ts'

const resource = (id: string): FhirResource =>
  Schema.decodeUnknownSync(Patient.Schema)({ resourceType: 'Patient', id })

const formatResult = (keys: readonly string[]): FormatDecode.Result<string> => ({
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
  unreadableFiles: [],
})

describe('planFormatWrite', () => {
  it('should skip a format with only unreadable files as unreadable', () => {
    const result: FormatDecode.Result<string> = {
      id: 'u',
      title: 'broken.har',
      files: [{ fileName: 'broken.har', bytes: new Uint8Array(), source: PickedFileSource.local }],
      format: 'har',
      decoded: { sections: [], notes: [] },
      unreadableFiles: [
        {
          id: 'broken',
          title: 'broken.har',
          pickedFile: {
            fileName: 'broken.har',
            bytes: new Uint8Array(),
            source: PickedFileSource.local,
          },
          error: new ParseResult.ParseError({
            issue: new ParseResult.Type(Schema.Never.ast, 'x', 'unreadable'),
          }),
        },
      ],
    }
    expect(planFormatWrite(result, StagedImport.initial())).toEqual({
      _tag: 'skip',
      reason: 'unreadable',
    })
  })

  it('property: writes exactly the included resources in review order, edits substituted, excluded counted', () => {
    const keysArbitrary = fc.uniqueArray(fc.stringMatching(/^[a-z]{1,4}$/u), { maxLength: 6 })
    fc.assert(
      fc.property(
        keysArbitrary,
        fc.func(fc.boolean()),
        fc.func(fc.boolean()),
        (keys, excludes, edits) => {
          let selection = StagedImport.initial()
          for (const key of keys) {
            if (excludes(key)) selection = StagedImport.toggleResource(selection, key)
            if (edits(key)) selection = StagedImport.edit(selection, key, resource(`${key}-edited`))
          }
          const plan = planFormatWrite(formatResult(keys), selection)
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
