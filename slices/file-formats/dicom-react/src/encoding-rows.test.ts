import { DicomHeader } from 'dicom'
import { describePixelDataFixture, dicomHeaderArb, writeDicom } from 'dicom/test-helpers'
import { Either } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { encodingRows, type EncodingRow } from './encoding-rows.ts'

/** Every tag a file must carry to parse at all, and nothing else. */
const MINIMAL_TAGS = {
  StudyInstanceUID: '1.2.3.4.5',
  SeriesInstanceUID: '1.2.3.4.6',
  SOPInstanceUID: '1.2.3.4.7',
  SOPClassUID: '1.2.840.10008.5.1.4.1.1.7',
  Modality: 'OT',
} as const

/** Parse a fixture the way the preview does, failing loudly if it cannot. */
const headerFrom = (tags: Parameters<typeof writeDicom>[0]): DicomHeader.Type => {
  const parsed = DicomHeader.tryFromDicomFile(writeDicom(tags))
  if (Either.isLeft(parsed)) throw new Error(`fixture did not parse: ${parsed.left.reason}`)
  return parsed.right
}

const rowsByLabel = (header: DicomHeader.Type): Readonly<Record<string, EncodingRow>> =>
  Object.fromEntries(encodingRows(header).map((row) => [row.label, row]))

describe('encodingRows', () => {
  it('emits every row for every header, absent values included (property)', () => {
    fc.assert(
      fc.property(dicomHeaderArb(), (header) => {
        const rows = encodingRows(header)
        const labels = rows.map((row) => row.label)

        // A row that disappeared when its tag was absent would read as "not
        // checked" rather than "not present", which is the opposite of what
        // this section is for.
        expect(labels).toEqual([
          'Transfer Syntax',
          'SOP Class',
          'Dimensions',
          'Samples / Pixel',
          'Photometric',
          'Planar Config',
          'Bit depth',
          'Pixel Repr.',
          'Rescale',
          'Window',
          'Pixel Data',
          'Parser warnings',
        ])
        // An empty string would render as a blank cell indistinguishable from
        // a present-but-empty tag; absence is carried by `undefined` alone.
        expect(rows.filter((row) => row.value === '' || row.detail === '')).toEqual([])
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('names a recognized transfer syntax and SOP class beneath the UID', () => {
    const rows = rowsByLabel(
      headerFrom({
        ...MINIMAL_TAGS,
        TransferSyntaxUID: '1.2.840.10008.1.2.4.90',
        SOPClassUID: '1.2.840.10008.5.1.4.1.1.2',
      })
    )

    expect(rows['Transfer Syntax']).toEqual({
      label: 'Transfer Syntax',
      value: '1.2.840.10008.1.2.4.90',
      detail: 'JPEG 2000 Lossless',
    })
    expect(rows['SOP Class']).toEqual({
      label: 'SOP Class',
      value: '1.2.840.10008.5.1.4.1.1.2',
      detail: 'CT Image Storage',
    })
  })

  it('says so when a UID is not in the table, rather than leaving the line blank', () => {
    const rows = rowsByLabel(headerFrom({ ...MINIMAL_TAGS, SOPClassUID: '1.2.999.888.777' }))

    expect(rows['SOP Class']).toEqual({
      label: 'SOP Class',
      value: '1.2.999.888.777',
      detail: 'Unrecognized UID',
    })
  })

  it('spells out the axis order and frame count', () => {
    const rows = rowsByLabel(
      headerFrom({ ...MINIMAL_TAGS, Rows: 512, Columns: 256, NumberOfFrames: 12 })
    )

    // DICOM's Rows is the height, so a bare "512 × 256" would be ambiguous.
    expect(rows['Dimensions']?.value).toBe('256 × 512 (w × h), 12 frames')
  })

  it('singularizes a one-frame instance', () => {
    const rows = rowsByLabel(
      headerFrom({ ...MINIMAL_TAGS, Rows: 64, Columns: 64, NumberOfFrames: 1 })
    )

    expect(rows['Dimensions']?.value).toBe('64 × 64 (w × h), 1 frame')
  })

  it('decodes the enumerated pixel-layout tags into words', () => {
    const rows = rowsByLabel(
      headerFrom({
        ...MINIMAL_TAGS,
        PlanarConfiguration: 1,
        PixelRepresentation: 1,
        BitsAllocated: 16,
        BitsStored: 12,
        HighBit: 11,
      })
    )

    expect(rows['Planar Config']?.value).toBe('1 (colour-by-plane)')
    expect(rows['Pixel Repr.']?.value).toBe('1 (signed (two’s complement))')
    expect(rows['Bit depth']?.value).toBe('16 allocated, 12 stored, high bit 11')
  })

  it('shows a value outside the enumeration as itself', () => {
    const rows = rowsByLabel(headerFrom({ ...MINIMAL_TAGS, PlanarConfiguration: 7 }))

    // Guessing a meaning for an out-of-spec value would hide the anomaly that
    // makes it worth showing.
    expect(rows['Planar Config']?.value).toBe('7')
  })

  it('describes encapsulated pixel data and why it needs a codec', () => {
    const fixture = { kind: 'encapsulated', fragmentLengths: [1024, 2048] } as const
    const rows = rowsByLabel(headerFrom({ ...MINIMAL_TAGS, PixelData: fixture }))

    // 3,104 = the empty basic offset table item (8) + each fragment's item
    // header and bytes (8 + 1024, 8 + 2048) + the sequence delimiter (8).
    expect(describePixelDataFixture(fixture).length).toBe(3104)
    expect(rows['Pixel Data']).toEqual({
      label: 'Pixel Data',
      value: 'OB, encapsulated, 2 fragments, 3,104 bytes',
      detail: 'Compressed — a codec for the transfer syntax above has to claim it',
    })
  })

  it('describes native pixel data without a codec note, grouping the byte count', () => {
    const rows = rowsByLabel(
      headerFrom({ ...MINIMAL_TAGS, PixelData: { kind: 'native', byteLength: 1234 } })
    )

    // Grouped without `toLocaleString`, so the digits do not depend on the
    // machine's locale.
    expect(rows['Pixel Data']).toEqual({
      label: 'Pixel Data',
      value: 'OB, native, 1,234 bytes',
      detail: undefined,
    })
  })

  it('states outright that an instance carries no pixel data', () => {
    const rows = rowsByLabel(headerFrom(MINIMAL_TAGS))

    // The most common reason a preview is blank, and an em-dash alone would
    // not distinguish it from a tag nobody read.
    expect(rows['Pixel Data']).toEqual({
      label: 'Pixel Data',
      value: undefined,
      detail: 'No (7FE0,0010) element — this instance carries no image',
    })
  })

  it('reports "none" rather than an em-dash when the parser had nothing to say', () => {
    const rows = rowsByLabel(headerFrom(MINIMAL_TAGS))

    expect(rows['Parser warnings']?.value).toBe('none')
  })

  it('leaves composite rows absent only when every part is absent', () => {
    const neither = rowsByLabel(headerFrom(MINIMAL_TAGS))
    const slopeOnly = rowsByLabel(headerFrom({ ...MINIMAL_TAGS, RescaleSlope: 2 }))
    const both = rowsByLabel(
      headerFrom({ ...MINIMAL_TAGS, RescaleSlope: 1, RescaleIntercept: -1024 })
    )

    expect(neither['Rescale']?.value).toBeUndefined()
    expect(slopeOnly['Rescale']?.value).toBe('slope 2')
    expect(both['Rescale']?.value).toBe('slope 1, intercept -1024')
  })

  it('passes a multi-valued window through as written', () => {
    const rows = rowsByLabel(
      headerFrom({ ...MINIMAL_TAGS, WindowCenter: '40\\300', WindowWidth: '400\\600' })
    )

    // Both tags are VM 1-n; collapsing to the first value would hide the other
    // presets the file offers.
    expect(rows['Window']?.value).toBe('center 40\\300, width 400\\600')
  })
})
