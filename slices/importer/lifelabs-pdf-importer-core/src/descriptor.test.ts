import { Effect } from 'effect'
import type { FhirResource } from 'fhir-r4/resources'
import type { LabeledResource } from 'importer-fundamentals'
import { describe, expect, it } from 'vite-plus/test'

import { lifeLabsPdfImporterDescriptor } from './descriptor.ts'
import { defaultLifeLabsPdfSettings } from './settings.ts'
import { layoutDocument } from './test-helpers.ts'

describe('lifeLabsPdfImporterDescriptor', () => {
  it('has the lifelabs-pdf format tag', () => {
    expect(lifeLabsPdfImporterDescriptor.format).toBe('lifelabs-pdf')
  })

  it('defaultSettings has a timeZone', () => {
    expect(lifeLabsPdfImporterDescriptor.defaultSettings).toEqual(defaultLifeLabsPdfSettings)
    expect(lifeLabsPdfImporterDescriptor.defaultSettings.timeZone).toBe('America/Toronto')
  })

  it('resolve is identity: it returns exactly what it receives', () => {
    const review: readonly LabeledResource<FhirResource>[] = [
      {
        key: 'Patient/abc',
        title: 'Patient/abc',
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test fixture
        resource: { resourceType: 'Patient' } as unknown as FhirResource,
      },
    ]

    const result = Effect.runSync(lifeLabsPdfImporterDescriptor.resolve(review))

    expect(result).toBe(review)
  })

  it('decode delegates to decodeLifeLabsPdf — an empty document with a valid zone produces an empty array', () => {
    const text = JSON.stringify(layoutDocument([]))

    const result = Effect.runSync(
      lifeLabsPdfImporterDescriptor.decode(text, defaultLifeLabsPdfSettings)
    )

    expect(result).toEqual([])
  })
})
