import { Either } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import * as DicomHeader from './dicom-header.ts'
import {
  describePixelDataFixture,
  dicomHeaderArb,
  headerToTagMap,
  pixelDataFragmentLengthsArb,
  writeDicom,
} from './test-helpers.ts'

const MINIMAL_UIDS = {
  StudyInstanceUID: '1.2.3.4.5',
  SeriesInstanceUID: '1.2.3.4.6',
  SOPInstanceUID: '1.2.3.4.7',
} as const

describe('DicomHeader.tryFromDicomFile', () => {
  it('round-trips every field through writeDicom', () => {
    fc.assert(
      fc.property(dicomHeaderArb(), (header) => {
        const bytes = writeDicom(headerToTagMap(header))
        const result = DicomHeader.tryFromDicomFile(bytes)

        expect(Either.isRight(result)).toBe(true)
        if (!Either.isRight(result)) return

        // Whole-value, so a field added to DicomHeader.Type without a matching
        // read in tryFromDicomFile (or a write in writeDicom) fails here rather
        // than passing unnoticed because nobody added an assertion for it.
        expect(result.right).toEqual(header)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('describes encapsulated pixel data by its fragments', () => {
    fc.assert(
      fc.property(pixelDataFragmentLengthsArb(), (fragmentLengths) => {
        const fixture = { kind: 'encapsulated', fragmentLengths } as const
        const bytes = writeDicom({ ...MINIMAL_UIDS, PixelData: fixture })

        const result = DicomHeader.tryFromDicomFile(bytes)

        expect(Either.isRight(result)).toBe(true)
        if (!Either.isRight(result)) return
        expect(result.right.pixelData).toEqual(describePixelDataFixture(fixture))
        // A compressed file whose fragments parsed cleanly warns about nothing;
        // the warnings a reader cares about come from a malformed one.
        expect(result.right.parserWarnings).toEqual([])
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('reads a blank numeric string as absent rather than NaN', () => {
    // A padded `'  '` is what writers emit for a numeric attribute they hold
    // no value for. `dicom-parser` runs parseFloat/parseInt over it and yields
    // NaN, which is not nullish — so it survives a `?? undefined` and is
    // reported as a number the file does not carry.
    const bytes = writeDicom({
      ...MINIMAL_UIDS,
      SeriesNumber: '  ',
      InstanceNumber: '  ',
      NumberOfFrames: '  ',
      RescaleIntercept: '  ',
      RescaleSlope: '  ',
    })

    const result = DicomHeader.tryFromDicomFile(bytes)

    expect(Either.isRight(result)).toBe(true)
    if (!Either.isRight(result)) return
    const { seriesNumber, instanceNumber, numberOfFrames, rescaleIntercept, rescaleSlope } =
      result.right
    expect({
      seriesNumber,
      instanceNumber,
      numberOfFrames,
      rescaleIntercept,
      rescaleSlope,
    }).toEqual({
      seriesNumber: undefined,
      instanceNumber: undefined,
      numberOfFrames: undefined,
      rescaleIntercept: undefined,
      rescaleSlope: undefined,
    })
  })

  it('still reads a well-formed numeric string', () => {
    // The guard above rejects NaN, not every value — a decimal that happens to
    // be zero, or a negative intercept, must still come through.
    const bytes = writeDicom({
      ...MINIMAL_UIDS,
      NumberOfFrames: 0,
      RescaleIntercept: -1024,
      RescaleSlope: 0.5,
    })

    const result = DicomHeader.tryFromDicomFile(bytes)

    expect(Either.isRight(result)).toBe(true)
    if (!Either.isRight(result)) return
    const { numberOfFrames, rescaleIntercept, rescaleSlope } = result.right
    expect({ numberOfFrames, rescaleIntercept, rescaleSlope }).toEqual({
      numberOfFrames: 0,
      rescaleIntercept: -1024,
      rescaleSlope: 0.5,
    })
  })

  it('reports no pixel data for an instance that carries none', () => {
    const result = DicomHeader.tryFromDicomFile(writeDicom(MINIMAL_UIDS))

    expect(Either.isRight(result)).toBe(true)
    if (!Either.isRight(result)) return
    // The honest answer for a Structured Report or Presentation State, and
    // what lets a viewer say "nothing to show" instead of "decode failed".
    expect(result.right.pixelData).toBeUndefined()
  })

  it('fails on truncated bytes', () => {
    const result = DicomHeader.tryFromDicomFile(new Uint8Array([0x00, 0x01, 0x02]))
    expect(Either.isLeft(result)).toBe(true)
  })

  it('fails when StudyInstanceUID is missing', () => {
    const bytes = writeDicom({
      // No StudyInstanceUID
      SeriesInstanceUID: '1.2.3.4',
      SOPInstanceUID: '1.2.3.5',
    })
    // Remove the study UID element by parsing and checking
    const result = DicomHeader.tryFromDicomFile(bytes)
    // writeDicom without StudyInstanceUID doesn't write the tag, so it fails
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left.reason).toContain('StudyInstanceUID')
    }
  })

  it('fails when SeriesInstanceUID is missing', () => {
    const bytes = writeDicom({
      StudyInstanceUID: '1.2.3.4',
      SOPInstanceUID: '1.2.3.5',
    })
    const result = DicomHeader.tryFromDicomFile(bytes)
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left.reason).toContain('SeriesInstanceUID')
    }
  })

  it('fails when SOPInstanceUID is missing', () => {
    const bytes = writeDicom({
      StudyInstanceUID: '1.2.3.4',
      SeriesInstanceUID: '1.2.3.5',
    })
    const result = DicomHeader.tryFromDicomFile(bytes)
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left.reason).toContain('SOPInstanceUID')
    }
  })
})
