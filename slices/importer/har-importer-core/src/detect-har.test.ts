import { describe, expect, it } from 'vite-plus/test'

import { detectHar, looksLikeJson } from './detect-har.ts'

/**
 * The picker calls every registered format's `detect` on every drop, so this
 * must stay cheap and syntactic: extension `.har` or JSON-object-shaped bytes.
 * The tests pin the byte-shape sniff and the extension test, matching the
 * anonymizer's HAR descriptor.
 */

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text)

describe('detectHar', () => {
  it('claims a `.har`-named file regardless of its bytes', () => {
    expect(detectHar(new Uint8Array(), 'capture.har')).toBe(true)
    expect(detectHar(new Uint8Array(), 'capture.HAR')).toBe(true)
    expect(detectHar(bytesOf('anything'), 'capture.har')).toBe(true)
  })

  it('claims a file whose bytes look like a JSON object regardless of its name', () => {
    expect(detectHar(bytesOf('{"log":{"version":"1.2"}}'), 'no-extension')).toBe(true)
    expect(detectHar(bytesOf('   \n\t{"a":1}'), 'export.json')).toBe(true)
  })

  it('claims neither a non-JSON, non-.har file nor an empty one', () => {
    expect(detectHar(bytesOf('%PDF-1.7\n%����\n1 0 obj'), 'report.pdf')).toBe(false)
    expect(detectHar(bytesOf('hello world'), 'notes.txt')).toBe(false)
    expect(detectHar(new Uint8Array(), 'unknown')).toBe(false)
  })

  it('skips a UTF-8 BOM before checking for `{`', () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf])
    const bytes = new Uint8Array(bom.length + 2)
    bytes.set(bom, 0)
    bytes.set(bytesOf('{}'), bom.length)
    expect(looksLikeJson(bytes)).toBe(true)
    expect(detectHar(bytes, 'no-extension')).toBe(true)
  })
})
