import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Either } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import * as DicomHeader from './dicom-header.ts'
import * as SpecificCharacterSet from './specific-character-set.ts'
import {
  describePixelDataFixture,
  dicomHeaderArb,
  headerToTagMap,
  pixelDataFragmentLengthsArb,
  withElementsSpliced,
  writeDicom,
} from './test-helpers.ts'

/** Every tag a file must carry to parse at all, and nothing else. */
const MINIMAL_UIDS = {
  StudyInstanceUID: '1.2.3.4.5',
  SeriesInstanceUID: '1.2.3.4.6',
  SOPInstanceUID: '1.2.3.4.7',
  SOPClassUID: '1.2.840.10008.5.1.4.1.1.2',
  Modality: 'CT',
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
    const { StudyInstanceUID: _omitted, ...rest } = MINIMAL_UIDS
    const bytes = writeDicom(rest)
    // Remove the study UID element by parsing and checking
    const result = DicomHeader.tryFromDicomFile(bytes)
    // writeDicom without StudyInstanceUID doesn't write the tag, so it fails
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left.reason).toContain('StudyInstanceUID')
    }
  })

  it('fails when SeriesInstanceUID is missing', () => {
    const { SeriesInstanceUID: _omitted, ...rest } = MINIMAL_UIDS
    const bytes = writeDicom(rest)
    const result = DicomHeader.tryFromDicomFile(bytes)
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left.reason).toContain('SeriesInstanceUID')
    }
  })

  it('fails when SOPInstanceUID is missing', () => {
    const { SOPInstanceUID: _omitted, ...rest } = MINIMAL_UIDS
    const bytes = writeDicom(rest)
    const result = DicomHeader.tryFromDicomFile(bytes)
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left.reason).toContain('SOPInstanceUID')
    }
  })

  it('fails when SOPClassUID is missing', () => {
    // Required since the synthesis names every instance's SOP Class and has
    // nothing to fall back on.
    const { SOPClassUID: _omitted, ...rest } = MINIMAL_UIDS
    const result = DicomHeader.tryFromDicomFile(writeDicom(rest))
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left.reason).toContain('SOPClassUID')
    }
  })

  it('fails when Modality is missing', () => {
    // Required for the same reason: a series is named by its Modality.
    const { Modality: _omitted, ...rest } = MINIMAL_UIDS
    const result = DicomHeader.tryFromDicomFile(writeDicom(rest))
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left.reason).toContain('Modality')
    }
  })
})

const PATIENT_NAME = 0x0010_0010
const INSTITUTION_NAME = 0x0008_0080

/** A file declaring `characterSet`, with one text element's bytes spliced in as that set encodes them. */
const fileWithText = (
  characterSet: string | undefined,
  text: { readonly tag: number; readonly vr: string; readonly bytes: readonly number[] }
): Uint8Array =>
  withElementsSpliced(
    writeDicom(
      characterSet === undefined
        ? MINIMAL_UIDS
        : { ...MINIMAL_UIDS, SpecificCharacterSet: characterSet }
    ),
    [{ tag: text.tag, vr: text.vr, value: new Uint8Array(text.bytes) }]
  )

/** The header a test expects to read, failing the test when there is none. */
const headerOf = (bytes: Uint8Array): DicomHeader.Type =>
  Either.getOrThrowWith(DicomHeader.tryFromDicomFile(bytes), (error) => new Error(error.reason))

/** The reason a test expects the file to fail for, failing the test when it reads. */
const undecodableReasonOf = (bytes: Uint8Array): string => {
  const result = DicomHeader.tryFromDicomFile(bytes)
  expect(Either.isLeft(result)).toBe(true)
  if (!Either.isLeft(result)) return ''
  expect(result.left).toBeInstanceOf(SpecificCharacterSet.UndecodableText)
  return result.left.reason
}

/** `Yamada^Tarou=` then `山田^太郎` in ISO 2022 IR 87, escapes and all — PS3.5 H.3.1. */
const YAMADA_ISO_2022_IR_87 = [
  ...new TextEncoder().encode('Yamada^Tarou='),
  0x1b,
  0x24,
  0x42,
  0x3b,
  0x33,
  0x45,
  0x44,
  0x1b,
  0x28,
  0x42,
  0x5e,
  0x1b,
  0x24,
  0x42,
  0x42,
  0x40,
  0x4f,
  0x3a,
  0x1b,
  0x28,
  0x42,
]

describe('DicomHeader.tryFromDicomFile text under SpecificCharacterSet (0008,0005)', () => {
  it('decodes UTF-8 under ISO_IR 192', () => {
    const bytes = writeDicom({
      ...MINIMAL_UIDS,
      SpecificCharacterSet: 'ISO_IR 192',
      PatientName: { family: 'Müller', given: 'Hans', text: 'Müller Hans' },
    })
    expect(headerOf(bytes).patientName).toEqual({
      family: 'Müller',
      given: 'Hans',
      text: 'Müller Hans',
    })
  })

  it('decodes Latin-1 under ISO_IR 100', () => {
    const bytes = fileWithText('ISO_IR 100', {
      tag: PATIENT_NAME,
      vr: 'PN',
      bytes: [0x4d, 0xfc, 0x6c, 0x6c, 0x65, 0x72, 0x5e, 0x48, 0x61, 0x6e, 0x73],
    })
    expect(headerOf(bytes).patientName).toEqual({
      family: 'Müller',
      given: 'Hans',
      text: 'Müller Hans',
    })
  })

  it('decodes Cyrillic under ISO_IR 144', () => {
    const bytes = fileWithText('ISO_IR 144', {
      tag: PATIENT_NAME,
      vr: 'PN',
      bytes: [0xb8, 0xd2, 0xd0, 0xdd, 0xde, 0xd2, 0x5e, 0xb8, 0xd2, 0xd0, 0xdd],
    })
    expect(headerOf(bytes).patientName).toEqual({
      family: 'Иванов',
      given: 'Иван',
      text: 'Иванов Иван',
    })
  })

  it('decodes Latin-1 when the file declares no character set', () => {
    const bytes = fileWithText(undefined, {
      tag: INSTITUTION_NAME,
      vr: 'LO',
      bytes: [0x4d, 0xfc, 0x6e, 0x63, 0x68, 0x65, 0x6e],
    })
    expect(headerOf(bytes).institutionName).toBe('München')
  })

  it('keeps a GBK character whole when its trail byte is ^', () => {
    // 0x81 0x5E is one character; splitting the bytes on 0x5E first would
    // read it as a family of 0x81 and an empty given name.
    const bytes = fileWithText('GBK', { tag: PATIENT_NAME, vr: 'PN', bytes: [0x81, 0x5e] })
    expect(headerOf(bytes).patientName).toEqual({ family: '乛', given: '', text: '乛' })
  })

  it('fails a file declaring the multi-valued ISO 2022 set its name is written in', () => {
    const reason = undecodableReasonOf(
      fileWithText('\\ISO 2022 IR 87', {
        tag: PATIENT_NAME,
        vr: 'PN',
        bytes: YAMADA_ISO_2022_IR_87,
      })
    )
    expect(reason).toContain('"\\ISO 2022 IR 87"')
    expect(reason).toContain('ISO 2022 code extensions are not supported')
  })

  it('fails a file declaring a multi-valued ISO 2022 set even when its text is ASCII', () => {
    // Ruth wants to learn when such files turn up, so the declared set alone
    // fails the file, whatever its text holds.
    const reason = undecodableReasonOf(
      writeDicom({
        ...MINIMAL_UIDS,
        SpecificCharacterSet: '\\ISO 2022 IR 149',
        PatientName: { family: 'Kim', given: 'Minjun', text: 'Kim Minjun' },
      })
    )
    expect(reason).toContain('"\\ISO 2022 IR 149"')
  })

  it('fails a file declaring an unknown term even when its text is ASCII', () => {
    const reason = undecodableReasonOf(
      writeDicom({
        ...MINIMAL_UIDS,
        SpecificCharacterSet: 'ISO_IR 999',
        PatientName: { family: 'Doe', given: 'Jane', text: 'Doe Jane' },
      })
    )
    expect(reason).toContain('unknown character set')
  })

  it('fails the whole file on an optional value its set cannot decode', () => {
    const reason = undecodableReasonOf(
      fileWithText('ISO_IR 192', { tag: INSTITUTION_NAME, vr: 'LO', bytes: [0x4d, 0xfc] })
    )
    expect(reason).toBe(
      'InstitutionName (0008,0080) cannot be decoded: SpecificCharacterSet (0008,0005) is "ISO_IR 192", and the value is not valid ISO_IR 192.'
    )
  })
})
