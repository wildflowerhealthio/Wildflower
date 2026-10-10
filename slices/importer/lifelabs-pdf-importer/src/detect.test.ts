import { describe, expect, it } from 'vite-plus/test'

import { detectLifeLabsPdf } from './detect.ts'

/**
 * Cheap syntactic identification: `%PDF-` magic bytes or a `.pdf` extension.
 * The full "is this a LifeLabs report?" check runs in `decodeLifeLabsPdf`,
 * so this test only pins the byte-shape sniff and the extension test.
 */

const pdfMagicWith = (tail: string): Uint8Array => {
  const magic = [0x25, 0x50, 0x44, 0x46, 0x2d]
  const tailBytes = new TextEncoder().encode(tail)
  const bytes = new Uint8Array(magic.length + tailBytes.length)
  bytes.set(magic, 0)
  bytes.set(tailBytes, magic.length)
  return bytes
}

describe('detectLifeLabsPdf', () => {
  it('claims a `.pdf`-named file regardless of its bytes', () => {
    expect(detectLifeLabsPdf(new Uint8Array(), 'report.pdf')).toBe(true)
    expect(detectLifeLabsPdf(new Uint8Array(), 'Report.PDF')).toBe(true)
    expect(detectLifeLabsPdf(new TextEncoder().encode('anything'), 'lab.pdf')).toBe(true)
  })

  it('claims a file whose bytes start with `%PDF-` regardless of its name', () => {
    expect(detectLifeLabsPdf(pdfMagicWith('1.7\n'), 'unknown')).toBe(true)
    expect(detectLifeLabsPdf(pdfMagicWith('1.4'), 'no-extension')).toBe(true)
  })

  it('does not claim a HAR-shaped file — neither the extension nor the bytes match', () => {
    const json = new TextEncoder().encode('{"log":{"version":"1.2"}}')
    expect(detectLifeLabsPdf(json, 'capture.har')).toBe(false)
    expect(detectLifeLabsPdf(json, 'export.json')).toBe(false)
  })

  it('rejects a short file that has neither the magic nor the extension', () => {
    expect(detectLifeLabsPdf(new Uint8Array([0x25, 0x50]), 'unknown')).toBe(false)
    expect(detectLifeLabsPdf(new Uint8Array(), 'notes.txt')).toBe(false)
  })
})
