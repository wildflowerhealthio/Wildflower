import { pixelDataFragmentLengthsArb, writeDicom } from 'dicom/test-helpers'
import { Either } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import {
  deidentifiedFileArbitrary,
  deidentifiedTagsArbitrary,
  elementBytesOf,
  withElementsSpliced,
} from './dicom-fixture.test-helpers.ts'
import * as Part10 from './part10.ts'

/**
 * The element stream reads and writes back every file whose data set is
 * Explicit VR Little Endian unchanged, and rejects the rest with a reason.
 */

const RUNS = numRunsFor({ base: 50 })

const decoded = (bytes: Uint8Array): Part10.Part10File =>
  Either.getOrThrowWith(Part10.decode(bytes), (error) => new Error(error.reason))

const reasonOf = (bytes: Uint8Array): string =>
  Either.match(Part10.decode(bytes), {
    onLeft: (error) => error.reason,
    onRight: () => 'decoded',
  })

/** An empty item — `(FFFE,E000)` with length 0 — and the delimiters around undefined-length values. */
const itemHeader = (element: number, length: number): Uint8Array => {
  const bytes = new Uint8Array(8)
  const view = new DataView(bytes.buffer)
  view.setUint16(0, 0xfffe, true)
  view.setUint16(2, element, true)
  view.setUint32(4, length, true)
  return bytes
}

/**
 * An undefined-length sequence holding one undefined-length item (itself
 * holding an undefined-length sequence) and one defined-length item: every
 * delimiter the walker has to find its way past.
 */
const nestedSequenceValue = (): Uint8Array => {
  const codeValue = elementBytesOf({ tag: 0x0008_0100, vr: 'SH', value: 'CODE' })
  const innerSequence = Part10.concat([
    itemHeader(0xe000, codeValue.length),
    codeValue,
    itemHeader(0xe0dd, 0),
  ])
  const inner = elementBytesOf({
    tag: 0x0040_a043,
    vr: 'SQ',
    value: innerSequence,
    undefinedLength: true,
  })
  const definedItemBody = elementBytesOf({ tag: 0x0008_0104, vr: 'LO', value: 'Meaning' })
  return Part10.concat([
    itemHeader(0xe000, 0xffff_ffff),
    inner,
    itemHeader(0xe00d, 0),
    itemHeader(0xe000, definedItemBody.length),
    definedItemBody,
    itemHeader(0xe0dd, 0),
  ])
}

describe('Part10', () => {
  test('property: decodes and encodes back a de-identified file byte for byte', () => {
    fc.assert(
      fc.property(deidentifiedFileArbitrary, (file) => {
        expect(Part10.encode(decoded(file))).toEqual(file)
      }),
      { numRuns: RUNS }
    )
  })

  test('property: carries encapsulated Pixel Data through unchanged', () => {
    fc.assert(
      fc.property(
        deidentifiedTagsArbitrary,
        pixelDataFragmentLengthsArb(),
        fc.constantFrom('1.2.840.10008.1.2.4.50', '1.2.840.10008.1.2.4.90', '1.2.840.10008.1.2.5'),
        (tags, fragmentLengths, transferSyntaxUid) => {
          const file = writeDicom({
            ...tags,
            TransferSyntaxUID: transferSyntaxUid,
            PixelData: { kind: 'encapsulated', fragmentLengths },
          })
          const pixelData = decoded(file).dataSet.at(-1)
          expect(pixelData?.tag).toBe(0x7fe0_0010)
          expect(pixelData?.undefinedLength).toBe(true)
          expect(Part10.encode(decoded(file))).toEqual(file)
        }
      ),
      { numRuns: RUNS }
    )
  })

  test('walks past nested undefined-length sequences and items to the next element', () => {
    const file = withElementsSpliced(
      writeDicom({
        StudyInstanceUID: '1.2.3',
        SeriesInstanceUID: '1.2.3.1',
        SOPInstanceUID: '1.2.3.1.1',
        Modality: 'DX',
      }),
      [{ tag: 0x0040_0260, vr: 'SQ', value: nestedSequenceValue(), undefinedLength: true }]
    )
    const { dataSet } = decoded(file)
    expect(dataSet.map((element) => element.tag)).toEqual([
      0x0008_0018, 0x0008_0060, 0x0020_000d, 0x0020_000e, 0x0040_0260,
    ])
    expect(Part10.encode(decoded(file))).toEqual(file)
  })

  test('counts the file meta group length from the elements it writes', () => {
    const file = decoded(
      writeDicom({
        StudyInstanceUID: '1.2',
        SeriesInstanceUID: '1.2.1',
        SOPInstanceUID: '1.2.1.1',
        Modality: 'CR',
      })
    )
    const withLongerMeta: Part10.Part10File = {
      ...file,
      meta: [
        ...file.meta,
        {
          tag: 0x0002_0013,
          vr: 'SH',
          value: new TextEncoder().encode('SYNTHETIC '),
          undefinedLength: false,
        },
      ],
    }
    const encoded = Part10.encode(withLongerMeta)
    const view = new DataView(encoded.buffer)
    const metaStart = 132 + 12
    const firstDataSetGroup = view.getUint16(metaStart + view.getUint32(140, true), true)
    expect(firstDataSetGroup).toBe(0x0008)
    expect(decoded(encoded).meta).toEqual(withLongerMeta.meta)
  })

  test.each([
    ['Implicit VR Little Endian', '1.2.840.10008.1.2'],
    ['Explicit VR Big Endian', '1.2.840.10008.1.2.2'],
    ['Deflated Explicit VR Little Endian', '1.2.840.10008.1.2.1.99'],
    ['JPIP Referenced Deflate', '1.2.840.10008.1.2.4.95'],
    ['JPIP HTJ2K Referenced Deflate', '1.2.840.10008.1.2.4.205'],
  ])('rejects a file declaring %s', (_name, transferSyntaxUid) => {
    const file = writeDicom({
      StudyInstanceUID: '1.2',
      SeriesInstanceUID: '1.2.1',
      SOPInstanceUID: '1.2.1.1',
      Modality: 'CR',
      TransferSyntaxUID: transferSyntaxUid,
    })
    expect(reasonOf(file)).toBe(
      `Transfer syntax ${transferSyntaxUid} does not encode its data set as Explicit VR Little Endian.`
    )
  })

  test('rejects a data set element with no explicit VR', () => {
    const file = writeDicom({
      StudyInstanceUID: '1.2',
      SeriesInstanceUID: '1.2.1',
      SOPInstanceUID: '1.2.1.1',
      Modality: 'CR',
    })
    // An Implicit VR element: tag, then a 4-byte length where the VR would be.
    const implicit = new Uint8Array([0x08, 0x00, 0x18, 0x00, 0x02, 0x00, 0x00, 0x00, 0x31, 0x00])
    expect(reasonOf(Part10.concat([file, implicit]))).toMatch(
      /^\(0008,0018\) at byte \d+ has no explicit VR/
    )
  })

  test('rejects bytes with no DICM prefix, and a file cut short inside an element', () => {
    const file = writeDicom({
      StudyInstanceUID: '1.2',
      SeriesInstanceUID: '1.2.1',
      SOPInstanceUID: '1.2.1.1',
      Modality: 'CR',
    })
    expect(reasonOf(file.slice(4))).toBe(
      'No DICM prefix at byte 128; only a DICOM Part 10 file is read.'
    )
    expect(reasonOf(file.slice(0, -3))).toMatch(/^The file ends inside an element at byte \d+\.$/)
  })

  test('refuses to encode an odd-length value, or a short-VR value past 16 bits', () => {
    const file = decoded(
      writeDicom({
        StudyInstanceUID: '1.2',
        SeriesInstanceUID: '1.2.1',
        SOPInstanceUID: '1.2.1.1',
        Modality: 'CR',
      })
    )
    const withElement = (value: Uint8Array): Part10.Part10File => ({
      ...file,
      dataSet: [...file.dataSet, { tag: 0x0008_1030, vr: 'LO', value, undefinedLength: false }],
    })
    expect(() => Part10.encode(withElement(new Uint8Array(3)))).toThrow(/odd-length/)
    expect(() => Part10.encode(withElement(new Uint8Array(0x1_0000)))).toThrow(/16-bit length/)
  })
})
