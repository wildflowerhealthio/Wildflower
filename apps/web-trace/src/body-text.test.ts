import fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { bodyText, bytesOfBase64 } from './body-text.ts'

/** Base64 of `bytes`, built the way the capture side builds it. */
const base64Of = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes))

const storedBody = (
  data: string,
  size: number,
  contentType = 'application/json'
): Parameters<typeof bodyText>[0] => ({
  _tag: 'StoredBody',
  contentType,
  data,
  size,
  hash: '',
})

describe('bytesOfBase64', () => {
  // `atob` yields one code unit per byte; decoding that string as UTF-16 (the
  // obvious-looking `TextEncoder` shortcut) corrupts every byte above 0x7F.
  test('round-trips arbitrary bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 512 }), (bytes: Uint8Array) => {
        expect([...bytesOfBase64(base64Of(bytes))]).toEqual([...bytes])
      })
    )
  })
})

describe('bodyText', () => {
  test('decodes a UTF-8 body to text', () => {
    const text = '{"resourceType":"Patient","name":"Ünïcøde"}'
    const bytes = new TextEncoder().encode(text)
    expect(bodyText(storedBody(base64Of(bytes), bytes.length))).toEqual({ kind: 'text', text })
  })

  // A lenient decode substitutes U+FFFD, which would show a JPEG as a wall of
  // replacement characters and claim it was text — exactly the lossiness the
  // capture side stores raw bytes to avoid.
  test('reports bytes that are not valid UTF-8 as binary rather than mangling them', () => {
    const invalid = Uint8Array.from([0xff, 0xfe, 0xfd])
    expect(bodyText(storedBody(base64Of(invalid), invalid.length, 'image/jpeg'))).toEqual({
      kind: 'binary',
      size: 3,
      contentType: 'image/jpeg',
    })
  })

  // One unreadable body must not take the viewer down.
  test('reports malformed base64 as binary rather than raising', () => {
    expect(bodyText(storedBody('not base64!!', 12)).kind).toBe('binary')
  })

  test('an empty body is text, not binary', () => {
    expect(bodyText(storedBody('', 0))).toEqual({ kind: 'text', text: '' })
  })

  // A skipped body reads as skipped. Flattening it into "no body" would make
  // the viewer claim something the trace does not.
  test('carries a skipped body’s size and reason through', () => {
    expect(
      bodyText({
        _tag: 'SkippedBody',
        contentType: 'video/mp4',
        size: 9_000_000,
        hash: '',
        reason: 'over maxBodyBytes',
      })
    ).toEqual({ kind: 'skipped', size: 9_000_000, reason: 'over maxBodyBytes' })
  })

  test('every stored body resolves to exactly one of text or binary, never a throw', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 256 }), (bytes: Uint8Array) => {
        const result = bodyText(storedBody(base64Of(bytes), bytes.length))
        expect(['text', 'binary']).toContain(result.kind)
      })
    )
  })
})
