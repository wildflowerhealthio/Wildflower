import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Either } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import * as SpecificCharacterSet from './specific-character-set.ts'

/** A supported value, failing the test when it is not one. */
const characterSetOf = (value: string | undefined): SpecificCharacterSet.Type =>
  Either.getOrThrowWith(
    SpecificCharacterSet.fromValue(value),
    (error) => new Error(`${String(value)}: ${error.reason}`)
  )

/**
 * Every supported term and the encoding the WHATWG Encoding standard resolves
 * its `TextDecoder` label to — PS3.3 Tables C.12-2, C.12-3 and C.12-5.
 */
const RESOLVED_ENCODINGS: readonly (readonly [string, string])[] = [
  ['ISO_IR 6', 'windows-1252'],
  ['ISO 2022 IR 6', 'windows-1252'],
  ['ISO_IR 100', 'windows-1252'],
  ['ISO 2022 IR 100', 'windows-1252'],
  ['ISO_IR 101', 'iso-8859-2'],
  ['ISO 2022 IR 101', 'iso-8859-2'],
  ['ISO_IR 109', 'iso-8859-3'],
  ['ISO 2022 IR 109', 'iso-8859-3'],
  ['ISO_IR 110', 'iso-8859-4'],
  ['ISO 2022 IR 110', 'iso-8859-4'],
  ['ISO_IR 144', 'iso-8859-5'],
  ['ISO 2022 IR 144', 'iso-8859-5'],
  ['ISO_IR 127', 'iso-8859-6'],
  ['ISO 2022 IR 127', 'iso-8859-6'],
  ['ISO_IR 126', 'iso-8859-7'],
  ['ISO 2022 IR 126', 'iso-8859-7'],
  ['ISO_IR 138', 'iso-8859-8'],
  ['ISO 2022 IR 138', 'iso-8859-8'],
  ['ISO_IR 148', 'windows-1254'],
  ['ISO 2022 IR 148', 'windows-1254'],
  ['ISO_IR 203', 'iso-8859-15'],
  ['ISO 2022 IR 203', 'iso-8859-15'],
  ['ISO_IR 13', 'shift_jis'],
  ['ISO 2022 IR 13', 'shift_jis'],
  ['ISO_IR 166', 'windows-874'],
  ['ISO 2022 IR 166', 'windows-874'],
  ['ISO_IR 192', 'utf-8'],
  ['GB18030', 'gb18030'],
  ['GBK', 'gbk'],
]

const LABEL = 'PatientName (0010,0010)'

describe('SpecificCharacterSet.fromValue', () => {
  it.each(RESOLVED_ENCODINGS)('builds the %s decoder as %s', (term, encoding) => {
    const characterSet = characterSetOf(term)
    expect({ term: characterSet.term, encoding: characterSet.decoder.encoding }).toEqual({
      term,
      encoding,
    })
  })

  it('matches a term with the padding a CS value carries', () => {
    expect(characterSetOf(' ISO_IR 192 ').decoder.encoding).toBe('utf-8')
  })

  it.each([undefined, '', ' ', 'ISO_IR 6'])('decodes 0xFC as ü when the value is %j', (value) => {
    const decoded = SpecificCharacterSet.decode(
      characterSetOf(value),
      new Uint8Array([0xfc]),
      LABEL
    )
    expect(decoded).toEqual(Either.right('ü'))
  })

  it.each(['\\ISO 2022 IR 87', 'ISO 2022 IR 6\\ISO 2022 IR 100', 'ISO 2022 IR 149'])(
    'refuses the ISO 2022 code extensions of %j, naming the value',
    (value) => {
      const result = SpecificCharacterSet.fromValue(value)
      expect(result).toEqual(
        Either.left(
          new SpecificCharacterSet.UndecodableText({
            reason: `SpecificCharacterSet (0008,0005) is "${value}", and ISO 2022 code extensions are not supported.`,
          })
        )
      )
    }
  )

  it.each(['ISO_IR 999', 'ISO_IR100', 'iso_ir 100'])(
    'refuses the unknown term %j, naming it',
    (value) => {
      const result = SpecificCharacterSet.fromValue(value)
      expect(Either.isLeft(result)).toBe(true)
      if (!Either.isLeft(result)) return
      expect(result.left).toBeInstanceOf(SpecificCharacterSet.UndecodableText)
      expect(result.left.reason).toContain(`"${value}"`)
      expect(result.left.reason).toContain('unknown character set')
    }
  )
})

describe('SpecificCharacterSet.decode', () => {
  it('refuses any value holding ESC, under every set', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(undefined, ...RESOLVED_ENCODINGS.map(([term]) => term)),
        fc.uint8Array({ maxLength: 16 }),
        fc.uint8Array({ maxLength: 16 }),
        (value, before, after) => {
          const bytes = new Uint8Array([...before, 0x1b, ...after])
          const result = SpecificCharacterSet.decode(characterSetOf(value), bytes, LABEL)
          expect(Either.isLeft(result)).toBe(true)
          if (!Either.isLeft(result)) return
          expect(result.left.reason).toContain(LABEL)
          expect(result.left.reason).toContain('ISO 2022 escape sequences')
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('reads ASCII bytes as ASCII, under every set', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(undefined, ...RESOLVED_ENCODINGS.map(([term]) => term)),
        fc.string({
          unit: fc.integer({ min: 0x20, max: 0x7e }).map((code) => String.fromCharCode(code)),
        }),
        (value, text) => {
          const bytes = new TextEncoder().encode(text)
          expect(SpecificCharacterSet.decode(characterSetOf(value), bytes, LABEL)).toEqual(
            Either.right(text)
          )
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('refuses invalid UTF-8 under ISO_IR 192, naming the field and the set', () => {
    const result = SpecificCharacterSet.decode(
      characterSetOf('ISO_IR 192'),
      new Uint8Array([0x4d, 0xfc]),
      LABEL
    )
    expect(result).toEqual(
      Either.left(
        new SpecificCharacterSet.UndecodableText({
          reason:
            'PatientName (0010,0010) cannot be decoded: SpecificCharacterSet (0008,0005) is "ISO_IR 192", and the value is not valid ISO_IR 192.',
        })
      )
    )
  })

  it('decodes a GBK character whose trail byte is ^', () => {
    expect(
      SpecificCharacterSet.decode(characterSetOf('GBK'), new Uint8Array([0x81, 0x5e]), LABEL)
    ).toEqual(Either.right('乛'))
  })
})
