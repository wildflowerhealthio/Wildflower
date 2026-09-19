/**
 * How the Pixel Data element is laid out in the file — the description a
 * viewer reads when it has nothing to show.
 *
 * @packageDocumentation
 */

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
interface PixelDataDescription {
  readonly vr: string | undefined
  readonly length: number
  readonly encapsulated: boolean
  readonly fragmentCount: number | undefined
}

export type { PixelDataDescription }
