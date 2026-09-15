import { describe, expect, it } from 'vite-plus/test'

import { detectDicom, DICM_MAGIC, DICM_MAGIC_OFFSET, hasDicmMagic } from './detect.ts'

/**
 * Binary detection: the DICOM PS3.10 preamble (128 bytes of anything)
 * followed by the four-byte ASCII `DICM` magic, or a `.dcm` extension
 * fallback for files that omit the preamble.
 */

const withDicmMagic = (tail: Uint8Array = new Uint8Array()): Uint8Array => {
  const result = new Uint8Array(DICM_MAGIC_OFFSET + DICM_MAGIC.length + tail.length)
  result.set(DICM_MAGIC, DICM_MAGIC_OFFSET)
  result.set(tail, DICM_MAGIC_OFFSET + DICM_MAGIC.length)
  return result
}

describe('hasDicmMagic', () => {
  it('returns true when the DICM magic sits at offset 128', () => {
    expect(hasDicmMagic(withDicmMagic())).toBe(true)
  })

  it('returns true even when the preamble is non-zero', () => {
    const bytes = withDicmMagic()
    bytes[0] = 0xff
    bytes[127] = 0xfe
    expect(hasDicmMagic(bytes)).toBe(true)
  })

  it('returns false when the file is shorter than 132 bytes', () => {
    expect(hasDicmMagic(new Uint8Array(131))).toBe(false)
    expect(hasDicmMagic(new Uint8Array())).toBe(false)
  })

  it('returns false when the magic is at the wrong offset', () => {
    const bytes = new Uint8Array(200)
    bytes.set(DICM_MAGIC, 0)
    expect(hasDicmMagic(bytes)).toBe(false)
  })
})

describe('detectDicom', () => {
  it('claims a file with DICM magic regardless of its name', () => {
    expect(detectDicom(withDicmMagic(), 'unknown')).toBe(true)
    expect(detectDicom(withDicmMagic(), 'image.png')).toBe(true)
  })

  it('claims a `.dcm`-named file regardless of its bytes', () => {
    expect(detectDicom(new Uint8Array(), 'scan.dcm')).toBe(true)
    expect(detectDicom(new Uint8Array(), 'Scan.DCM')).toBe(true)
    expect(detectDicom(new TextEncoder().encode('anything'), 'image.dcm')).toBe(true)
  })

  it('does not claim a file that has neither the magic nor the extension', () => {
    const json = new TextEncoder().encode('{"log":{"version":"1.2"}}')
    expect(detectDicom(json, 'capture.har')).toBe(false)
    expect(detectDicom(json, 'export.json')).toBe(false)
    expect(detectDicom(new Uint8Array(), 'notes.txt')).toBe(false)
  })

  it('rejects a short file with no `.dcm` extension', () => {
    expect(detectDicom(new Uint8Array([0x44, 0x49]), 'unknown')).toBe(false)
    expect(detectDicom(new Uint8Array(), '')).toBe(false)
  })
})
