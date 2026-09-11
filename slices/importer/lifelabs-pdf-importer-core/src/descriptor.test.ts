import { Effect } from 'effect'
import type { FhirResource } from 'fhir-r4/resources'
import type { LabeledResource } from 'importer-fundamentals'
import { describe, expect, it } from 'vite-plus/test'

import { lifeLabsPdfImporterDescriptor } from './descriptor.ts'
import { defaultLifeLabsPdfSettings } from './settings.ts'

describe('lifeLabsPdfImporterDescriptor', () => {
  it('has the lifelabs-pdf format tag', () => {
    expect(lifeLabsPdfImporterDescriptor.format).toBe('lifelabs-pdf')
  })

  it('surfaces only the source PDF in the picker accept tokens — the anonymizer JSON is a separate artifact', () => {
    expect([...lifeLabsPdfImporterDescriptor.accept]).toEqual(['.pdf', 'application/pdf'])
  })

  it('detects a PDF by `%PDF-` magic bytes and by the `.pdf` extension', () => {
    const pdfMagic = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])
    expect(lifeLabsPdfImporterDescriptor.detect(pdfMagic, 'unknown')).toBe(true)
    expect(lifeLabsPdfImporterDescriptor.detect(new Uint8Array(), 'report.pdf')).toBe(true)
    expect(lifeLabsPdfImporterDescriptor.detect(new Uint8Array(), 'report.PDF')).toBe(true)
  })

  it('does not claim a HAR-shaped file — neither the extension nor the bytes match', () => {
    const jsonLike = new TextEncoder().encode('{"log":{"version":"1.2"}}')
    expect(lifeLabsPdfImporterDescriptor.detect(jsonLike, 'capture.har')).toBe(false)
    expect(lifeLabsPdfImporterDescriptor.detect(jsonLike, 'export.json')).toBe(false)
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
})
