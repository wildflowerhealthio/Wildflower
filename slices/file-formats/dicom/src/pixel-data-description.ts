/**
 * How the Pixel Data element is laid out in the file — the description a
 * viewer reads when it has nothing to show.
 *
 * @packageDocumentation
 */

import type { DataSet } from 'dicom-parser'

/** The Pixel Data element tag, (7FE0,0010). */
const PIXEL_DATA_TAG = 'x7fe00010'

/**
 * How the Pixel Data element (7FE0,0010) is laid out in the file, as distinct
 * from the pixels it encodes.
 *
 * @remarks
 * When a viewer shows a blank pane the answer is usually here. The whole value
 * being `undefined` means the file has no pixels at all — a Structured Report
 * or Presentation State. `encapsulated` means the frames are compressed, so a
 * codec must claim the file's transfer syntax before anything renders.
 *
 * `length` spans more than the frames for an encapsulated element: the basic
 * offset table, each fragment's item header and bytes, and the sequence
 * delimiter.
 */
interface Type {
  readonly vr: string | undefined
  readonly length: number
  readonly encapsulated: boolean
  readonly fragmentCount: number | undefined
}

/**
 * Describe the Pixel Data element (7FE0,0010) of a parsed dataset without
 * decoding it.
 *
 * @remarks
 * `undefined` means the file carries no pixel data element at all. That is the
 * honest answer for a Structured Report or a Presentation State, and it is
 * what a viewer needs to distinguish "no image here" from "an image I could
 * not decode". See {@link Type} for what `length` spans.
 */
const tryFromDataSet = (dataSet: DataSet): Type | undefined => {
  const element = dataSet.elements[PIXEL_DATA_TAG]
  if (element === undefined) return undefined
  return {
    vr: element.vr,
    length: element.length,
    encapsulated: element.encapsulatedPixelData === true,
    fragmentCount: element.fragments?.length,
  }
}

export { tryFromDataSet, type Type }
