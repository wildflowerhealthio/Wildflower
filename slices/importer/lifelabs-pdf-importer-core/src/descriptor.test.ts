import { describe, expect, it } from 'vite-plus/test'

import { lifeLabsPdfImporterDescriptor } from './descriptor.ts'
import { defaultLifeLabsPdfSettings } from './settings.ts'

describe('lifeLabsPdfImporterDescriptor', () => {
  it('has the lifelabs-pdf format tag', () => {
    expect(lifeLabsPdfImporterDescriptor.format).toBe('lifelabs-pdf')
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
})
