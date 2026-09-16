import { Effect } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { perFileDecode, sectionResources, sourceFileKey } from './file-importer-descriptor.ts'
import type { DecodedFile, LabeledSection, PickedFileLike } from './file-importer-descriptor.ts'

describe('sectionResources', () => {
  it('should flatten a decoded file’s sections into one list, in section order', () => {
    const sections: readonly LabeledSection<string>[] = [
      {
        title: 'https://r4.example.org/Patient/pat-7',
        resources: [{ key: 'req-0:0', title: 'Patient/pat-7', resource: 'patient' }],
      },
      {
        title: 'https://r4.example.org/Observation?patient=pat-7',
        resources: [
          { key: 'req-1:0', title: 'Observation/obs-1', resource: 'weight' },
          { key: 'req-1:1', title: 'Observation/obs-2', resource: 'height' },
        ],
      },
    ]

    expect(sectionResources(sections).map((entry) => entry.key)).toEqual([
      'req-0:0',
      'req-1:0',
      'req-1:1',
    ])
  })

  it('property: flattening preserves every resource exactly once, in order', () => {
    const sectionArbitrary = fc.record({
      title: fc.string(),
      resources: fc.array(
        fc.record({ key: fc.string(), title: fc.string(), resource: fc.integer() })
      ),
    })
    fc.assert(
      fc.property(fc.array(sectionArbitrary), (sections) => {
        const flat = sectionResources(sections)

        expect(flat).toEqual(sections.flatMap((section) => section.resources))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('perFileDecode', () => {
  const mockDecode = (
    fileBytes: Uint8Array,
    _settings: null
  ): Effect.Effect<DecodedFile<string>, never> =>
    Effect.succeed({
      sections: [
        {
          title: 'section',
          resources: [
            { key: `key-${fileBytes[0]}`, title: 'r', resource: `resource-${fileBytes[0]}` },
          ],
        },
      ],
      notes: [],
    })

  const wrapped = perFileDecode(mockDecode)

  it('should produce one unit per input file', () => {
    const files: readonly PickedFileLike[] = [
      { fileName: 'a.har', bytes: new Uint8Array([1]) },
      { fileName: 'b.har', bytes: new Uint8Array([2]) },
      { fileName: 'c.har', bytes: new Uint8Array([3]) },
    ]
    const units = Effect.runSync(wrapped(files, null))
    expect(units).toHaveLength(3)
    for (let i = 0; i < files.length; i++) {
      expect(units[i].files).toEqual([files[i]])
      expect(units[i].decoded.sections).toHaveLength(1)
    }
  })

  it('should pass through the same file objects by reference', () => {
    const files: readonly PickedFileLike[] = [{ fileName: 'a.har', bytes: new Uint8Array([1]) }]
    const units = Effect.runSync(wrapped(files, null))
    expect(units[0].files[0]).toBe(files[0])
  })

  it('property: unit count equals input file count', () => {
    const fileArbitrary = fc.record({
      fileName: fc.string({ minLength: 1 }),
      bytes: fc.uint8Array({ minLength: 1, maxLength: 10 }),
    })
    fc.assert(
      fc.property(fc.array(fileArbitrary, { minLength: 1, maxLength: 20 }), (files) => {
        const units = Effect.runSync(wrapped(files, null))
        expect(units).toHaveLength(files.length)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })
})

describe('sourceFileKey', () => {
  it('should scope keys by file name', () => {
    expect(sourceFileKey('scan.dcm')).toBe('source-file/scan.dcm')
    expect(sourceFileKey('report.pdf')).toBe('source-file/report.pdf')
  })

  it('property: distinct file names produce distinct keys', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.string({ minLength: 1 }), (a, b) => {
        fc.pre(a !== b)
        expect(sourceFileKey(a)).not.toBe(sourceFileKey(b))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
