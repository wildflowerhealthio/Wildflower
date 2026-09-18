import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import * as FormatDetector from './format-detector.ts'
import type * as PickedFile from './picked-file.ts'

/** A detector claiming every file whose name ends in `extension`. */
const byExtension = (format: string, extension: string): FormatDetector.Type => ({
  format,
  detect: (_bytes, fileName) => fileName.toLowerCase().endsWith(extension),
})

/** A detector claiming every file whose first byte is `magic`. */
const byMagic = (format: string, magic: number): FormatDetector.Type => ({
  format,
  detect: (bytes) => bytes[0] === magic,
})

const named = (fileName: string, bytes: Uint8Array = new Uint8Array()): PickedFile.NamedBytes => ({
  fileName,
  bytes,
})

describe('FormatDetector.claiming', () => {
  it('should return the detector whose detect claims the file', () => {
    const har = byExtension('har', '.har')
    const pdf = byExtension('lifelabs-pdf', '.pdf')

    expect(FormatDetector.claiming([har, pdf], named('portal-session.har'))).toBe(har)
    expect(FormatDetector.claiming([har, pdf], named('report.pdf'))).toBe(pdf)
  })

  it('should return undefined when no detector claims the file', () => {
    expect(FormatDetector.claiming([byExtension('har', '.har')], named('scan.dcm'))).toBeUndefined()
  })

  it('should give a file both detectors claim to the earlier one', () => {
    const first = byMagic('first', 0x7b)
    const second = byMagic('second', 0x7b)

    expect(FormatDetector.claiming([first, second], named('a.json', new Uint8Array([0x7b])))).toBe(
      first
    )
  })

  it('should pass the bytes and the name to detect, in that order', () => {
    const seen: (readonly [Uint8Array, string])[] = []
    const spy: FormatDetector.Type = {
      format: 'spy',
      detect: (bytes, fileName) => {
        seen.push([bytes, fileName])
        return false
      },
    }
    const bytes = new Uint8Array([1, 2, 3])

    FormatDetector.claiming([spy], named('capture.har', bytes))

    expect(seen).toEqual([[bytes, 'capture.har']])
  })

  it('should return a detector at its own type, not narrowed to FormatDetector.Type', () => {
    const har = { ...byExtension('har', '.har'), title: 'HAR archive' }

    // Reading `title` off the result is the assertion: it only type-checks
    // because `claiming` returns `TDetector`, not `FormatDetector.Type`.
    expect(FormatDetector.claiming([har], named('portal-session.har'))?.title).toBe('HAR archive')
  })

  it('property: the result is the first claiming detector, or undefined when none claims', () => {
    const detectorArbitrary = fc
      .tuple(fc.string({ minLength: 1 }), fc.boolean())
      .map(([format, claims]): FormatDetector.Type => ({ format, detect: () => claims }))

    fc.assert(
      fc.property(
        fc.array(detectorArbitrary),
        fc.string(),
        fc.uint8Array(),
        (detectors, fileName, bytes) => {
          const claimed = FormatDetector.claiming(detectors, named(fileName, bytes))

          expect(claimed).toBe(detectors.find((one) => one.detect(bytes, fileName)))
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
