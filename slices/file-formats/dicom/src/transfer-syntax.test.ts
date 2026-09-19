import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import * as TransferSyntax from './transfer-syntax.ts'

describe('TransferSyntax.name', () => {
  it('names the two uncompressed syntaxes every writer emits', () => {
    expect(TransferSyntax.name('1.2.840.10008.1.2')).toBe('Implicit VR Little Endian')
    expect(TransferSyntax.name('1.2.840.10008.1.2.1')).toBe('Explicit VR Little Endian')
  })

  it('marks the lossy compressed syntaxes as lossy', () => {
    expect(TransferSyntax.name('1.2.840.10008.1.2.4.50')).toBe('JPEG Baseline 8-bit (lossy)')
    expect(TransferSyntax.name('1.2.840.10008.1.2.4.91')).toBe('JPEG 2000 (lossy)')
  })

  it('distinguishes the lossless JPEG 2000 syntax from the lossy one', () => {
    // 4.90 and 4.91 differ by one digit and by whether the pixels survive.
    expect(TransferSyntax.name('1.2.840.10008.1.2.4.90')).toBe('JPEG 2000 Lossless')
    expect(TransferSyntax.name('1.2.840.10008.1.2.4.90')).not.toBe(
      TransferSyntax.name('1.2.840.10008.1.2.4.91')
    )
  })

  it('returns undefined for an unknown UID rather than guessing', () => {
    fc.assert(
      fc.property(
        fc
          .array(fc.integer({ min: 0, max: 99 }), { minLength: 2, maxLength: 6 })
          .map((parts) => `9.9.${parts.join('.')}`),
        (uid) => {
          expect(TransferSyntax.name(uid)).toBeUndefined()
        }
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('is not fooled by inherited Object properties', () => {
    // A bare record lookup would answer `constructor` or `toString` with a
    // function, which a caller would then render as a transfer syntax name.
    expect(TransferSyntax.name('constructor')).toBeUndefined()
    expect(TransferSyntax.name('toString')).toBeUndefined()
    expect(TransferSyntax.name('__proto__')).toBeUndefined()
  })
})
