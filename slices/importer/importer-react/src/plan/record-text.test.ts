import { FhirResourceSchema } from '@wildflowerhealthio/fhir-r4/resources'
import { type ImportedCopy, ImportedRecord } from '@wildflowerhealthio/importer-fundamentals'
import { Array as Arr, DateTime, Option, Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import * as RecordText from './record-text.ts'

const NOW = DateTime.unsafeMake('2026-11-27T12:00:00Z')

/** The one record a file brings as a copy of the resource of the wire `fields`, titled `title`. */
const recordOf = (fields: object, title: string): ImportedRecord.Type => {
  const resource: ImportedCopy.Type['resource'] = {
    ...Schema.decodeUnknownSync(FhirResourceSchema)({ id: 'stage-id', ...fields }),
    id: null,
  }
  const copy: ImportedCopy.Type = {
    origin: {
      format: 'har',
      pickedFiles: [{ id: '0:a.har', fileName: 'a.har', bytes: new Uint8Array() }],
    },
    reviewKey: `0:a.har/${title}`,
    title,
    isImplied: false,
    resource,
    sourceUrl: Option.none(),
    stageId: { _tag: 'Minted', id: 'stage-id' },
  }
  return Option.getOrThrow(Arr.head(ImportedRecord.fromCopies([copy])))
}

describe('RecordText.titleOf', () => {
  it('names a Patient by the name she goes by', () => {
    const record = recordOf(
      { resourceType: 'Patient', name: [{ family: 'Banks', given: ['Tyra'] }] },
      'Patient/p-1'
    )

    expect(RecordText.titleOf(NOW, record)).toBe('Tyra Banks')
  })

  it('names a Practitioner by the name they go by', () => {
    const record = recordOf(
      { resourceType: 'Practitioner', name: [{ text: 'Dr. Jonathan Brown' }] },
      'Practitioner/pr-1'
    )

    expect(RecordText.titleOf(NOW, record)).toBe('Dr. Jonathan Brown')
  })

  it('names a person with no name by the title the plan shows', () => {
    const record = recordOf({ resourceType: 'Patient' }, 'Patient/p-1')

    expect(RecordText.titleOf(NOW, record)).toBe('Patient/p-1')
  })

  it('names any other record by the title the plan shows', () => {
    const record = recordOf(
      { resourceType: 'Observation', status: 'final', code: { text: 'Weight' } },
      'Weight · Observation'
    )

    expect(RecordText.titleOf(NOW, record)).toBe('Weight · Observation')
  })
})
