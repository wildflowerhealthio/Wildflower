import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { sopClassName, transferSyntaxName } from './uid-names.ts'

describe('transferSyntaxName', () => {
  it('names the two uncompressed syntaxes every writer emits', () => {
    expect(transferSyntaxName('1.2.840.10008.1.2')).toBe('Implicit VR Little Endian')
    expect(transferSyntaxName('1.2.840.10008.1.2.1')).toBe('Explicit VR Little Endian')
  })

  it('marks the lossy compressed syntaxes as lossy', () => {
    expect(transferSyntaxName('1.2.840.10008.1.2.4.50')).toBe('JPEG Baseline 8-bit (lossy)')
    expect(transferSyntaxName('1.2.840.10008.1.2.4.91')).toBe('JPEG 2000 (lossy)')
  })

  it('distinguishes the lossless JPEG 2000 syntax from the lossy one', () => {
    // 4.90 and 4.91 differ by one digit and by whether the pixels survive.
    expect(transferSyntaxName('1.2.840.10008.1.2.4.90')).toBe('JPEG 2000 Lossless')
    expect(transferSyntaxName('1.2.840.10008.1.2.4.90')).not.toBe(
      transferSyntaxName('1.2.840.10008.1.2.4.91')
    )
  })

  it('returns undefined for an unknown UID rather than guessing', () => {
    fc.assert(
      fc.property(
        fc
          .array(fc.integer({ min: 0, max: 99 }), { minLength: 2, maxLength: 6 })
          .map((parts) => `9.9.${parts.join('.')}`),
        (uid) => {
          expect(transferSyntaxName(uid)).toBeUndefined()
        }
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('is not fooled by inherited Object properties', () => {
    // A bare record lookup would answer `constructor` or `toString` with a
    // function, which a caller would then render as a transfer syntax name.
    expect(transferSyntaxName('constructor')).toBeUndefined()
    expect(transferSyntaxName('toString')).toBeUndefined()
    expect(transferSyntaxName('__proto__')).toBeUndefined()
  })
})

describe('sopClassName', () => {
  it('names the common image storage classes', () => {
    expect(sopClassName('1.2.840.10008.5.1.4.1.1.2')).toBe('CT Image Storage')
    expect(sopClassName('1.2.840.10008.5.1.4.1.1.4')).toBe('MR Image Storage')
  })

  it('names the non-image classes that explain an empty viewer', () => {
    expect(sopClassName('1.2.840.10008.5.1.4.1.1.88.11')).toBe('Basic Text SR Storage')
    expect(sopClassName('1.2.840.10008.5.1.4.1.1.11.1')).toBe(
      'Grayscale Softcopy Presentation State Storage'
    )
    expect(sopClassName('1.2.840.10008.5.1.4.1.1.104.1')).toBe('Encapsulated PDF Storage')
  })

  it('returns undefined for an unknown UID rather than guessing', () => {
    expect(sopClassName('1.2.840.10008.5.1.4.1.1.999')).toBeUndefined()
    expect(sopClassName('')).toBeUndefined()
  })

  it('is not fooled by inherited Object properties', () => {
    expect(sopClassName('constructor')).toBeUndefined()
    expect(sopClassName('valueOf')).toBeUndefined()
  })
})
