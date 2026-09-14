import { describe, expect, it } from 'vite-plus/test'

import { dicomImporterDescriptor } from './descriptor.ts'
import { defaultDicomSettings } from './settings.ts'

describe('dicomImporterDescriptor', () => {
  it('has the dicom format tag', () => {
    expect(dicomImporterDescriptor.format).toBe('dicom')
  })

  it('accepts .dcm extension and application/dicom MIME type', () => {
    expect([...dicomImporterDescriptor.accept]).toEqual(['.dcm', 'application/dicom'])
  })

  it('detects a file with DICM magic bytes at offset 128', () => {
    const bytes = new Uint8Array(132)
    bytes.set([0x44, 0x49, 0x43, 0x4d], 128)
    expect(dicomImporterDescriptor.detect(bytes, 'unknown')).toBe(true)
  })

  it('detects a file by .dcm extension', () => {
    expect(dicomImporterDescriptor.detect(new Uint8Array(), 'scan.dcm')).toBe(true)
    expect(dicomImporterDescriptor.detect(new Uint8Array(), 'Scan.DCM')).toBe(true)
  })

  it('does not claim a non-DICOM file', () => {
    const json = new TextEncoder().encode('{"log":{"version":"1.2"}}')
    expect(dicomImporterDescriptor.detect(json, 'capture.har')).toBe(false)
  })

  it('defaultSettings is the empty record', () => {
    expect(dicomImporterDescriptor.defaultSettings).toEqual(defaultDicomSettings)
    expect(Object.keys(dicomImporterDescriptor.defaultSettings)).toEqual([])
  })
})
