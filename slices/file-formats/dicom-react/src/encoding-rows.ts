/**
 * The Encoding section's rows: the decode-relevant half of a parsed
 * {@link DicomHeader}, formatted for display.
 *
 * @remarks
 * Pure and React-free so the formatting can be tested without a DOM. Every row
 * is emitted even when its value is absent — a blank Photometric
 * Interpretation is itself a finding, and a section that hides its empty rows
 * makes a reader wonder whether the field was read at all.
 *
 * @packageDocumentation
 */

import {
  PixelRepresentation,
  PlanarConfiguration,
  SopClass,
  TransferSyntax,
  type DicomHeader,
  type PixelDataDescription,
} from 'dicom'

/**
 * One labelled line. `value` is `undefined` when the tag is absent, which the
 * view renders as an em-dash. `detail` is a dimmer second line — a UID's
 * human-readable name, or why an absent value matters.
 */
interface EncodingRow {
  readonly label: string
  readonly value: string | undefined
  readonly detail: string | undefined
}

const UNRECOGNIZED = 'Unrecognized UID'

/** Group a byte count into thousands without `toLocaleString`, whose output varies by locale. */
const withThousands = (value: number): string =>
  value.toString().replace(/\B(?=(\d{3})+(?!\d))/gu, ',')

/** Join the parts of a composite value, or `undefined` when every part was absent. */
const joined = (parts: readonly (string | undefined)[]): string | undefined => {
  const present = parts.filter((part) => part !== undefined)
  return present.length === 0 ? undefined : present.join(', ')
}

const uidRow = (
  label: string,
  uid: string | undefined,
  name: (uid: string) => string | undefined
): EncodingRow => ({
  label,
  value: uid,
  detail: uid === undefined ? undefined : (name(uid) ?? UNRECOGNIZED),
})

/**
 * `columns × rows` — DICOM names the image's height `Rows` and its width
 * `Columns`, so the axis order is spelled out rather than left to be guessed.
 */
const dimensionsRow = (header: DicomHeader): EncodingRow => {
  const size =
    header.columns === undefined || header.rows === undefined
      ? undefined
      : `${header.columns} × ${header.rows} (w × h)`
  const frames =
    header.numberOfFrames === undefined
      ? undefined
      : `${header.numberOfFrames} frame${header.numberOfFrames === 1 ? '' : 's'}`
  return { label: 'Dimensions', value: joined([size, frames]), detail: undefined }
}

/**
 * `2 (colour-by-plane)`, or just `2` for a value outside the enumeration. The
 * enumerations themselves belong to `dicom` — what the standard says a value
 * means is not this view's choice.
 */
const enumeratedRow = (
  label: string,
  value: number | undefined,
  meaning: (value: number) => string | undefined
): EncodingRow => {
  if (value === undefined) return { label, value: undefined, detail: undefined }
  const meant = meaning(value)
  return {
    label,
    value: meant === undefined ? String(value) : `${value} (${meant})`,
    detail: undefined,
  }
}

const bitDepthRow = (header: DicomHeader): EncodingRow => ({
  label: 'Bit depth',
  value: joined([
    header.bitsAllocated === undefined ? undefined : `${header.bitsAllocated} allocated`,
    header.bitsStored === undefined ? undefined : `${header.bitsStored} stored`,
    header.highBit === undefined ? undefined : `high bit ${header.highBit}`,
  ]),
  detail: undefined,
})

/**
 * Describe the Pixel Data element. An absent element is the single most
 * informative thing this section can report, so it says so in words rather
 * than leaving an em-dash to be read as "not checked".
 */
const pixelDataRow = (pixelData: PixelDataDescription | undefined): EncodingRow => {
  if (pixelData === undefined) {
    return {
      label: 'Pixel Data',
      value: undefined,
      detail: 'No (7FE0,0010) element — this instance carries no image',
    }
  }
  const value = joined([
    pixelData.vr,
    pixelData.encapsulated ? 'encapsulated' : 'native',
    pixelData.fragmentCount === undefined
      ? undefined
      : `${pixelData.fragmentCount} fragment${pixelData.fragmentCount === 1 ? '' : 's'}`,
    `${withThousands(pixelData.length)} bytes`,
  ])
  return {
    label: 'Pixel Data',
    value,
    detail: pixelData.encapsulated
      ? 'Compressed — a codec for the transfer syntax above has to claim it'
      : undefined,
  }
}

const warningsRow = (warnings: readonly string[]): EncodingRow => ({
  label: 'Parser warnings',
  value: warnings.length === 0 ? 'none' : warnings.join('; '),
  detail: undefined,
})

/** Build the Encoding section's rows, in display order. */
const encodingRows = (header: DicomHeader): readonly EncodingRow[] => [
  uidRow('Transfer Syntax', header.transferSyntaxUid, TransferSyntax.name),
  uidRow('SOP Class', header.sopClassUid, SopClass.name),
  dimensionsRow(header),
  { label: 'Samples / Pixel', value: header.samplesPerPixel?.toString(), detail: undefined },
  { label: 'Photometric', value: header.photometricInterpretation, detail: undefined },
  enumeratedRow('Planar Config', header.planarConfiguration, PlanarConfiguration.meaning),
  bitDepthRow(header),
  enumeratedRow('Pixel Repr.', header.pixelRepresentation, PixelRepresentation.meaning),
  {
    label: 'Rescale',
    value: joined([
      header.rescaleSlope === undefined ? undefined : `slope ${header.rescaleSlope}`,
      header.rescaleIntercept === undefined ? undefined : `intercept ${header.rescaleIntercept}`,
    ]),
    detail: undefined,
  },
  {
    label: 'Window',
    value: joined([
      header.windowCenter === undefined ? undefined : `center ${header.windowCenter}`,
      header.windowWidth === undefined ? undefined : `width ${header.windowWidth}`,
    ]),
    detail: undefined,
  },
  pixelDataRow(header.pixelData),
  warningsRow(header.parserWarnings),
]

export { encodingRows, type EncodingRow }
