import { Data, Either } from 'effect'

/**
 * A DICOM Part 10 file as its top-level element stream: decoded into data
 * elements whose values are kept as raw bytes, and encoded back.
 *
 * @remarks
 * Only files whose data set is Explicit VR Little Endian are read — Explicit
 * VR Little Endian itself, and the encapsulated (compressed) transfer
 * syntaxes, which encode the data set the same way and differ only in how
 * Pixel Data is carried. Implicit VR, Big Endian and Deflated files are
 * rejected with an {@link UnsupportedDicomFile}.
 *
 * Nothing below the top level is interpreted: a sequence, or an
 * undefined-length Pixel Data element, is walked only to find where it ends,
 * and its value is carried as the bytes it was read from, delimiters included.
 * An element this module did not change encodes back byte for byte.
 */

/** A file this module cannot read, and why. */
class UnsupportedDicomFile extends Data.TaggedError('UnsupportedDicomFile')<{
  readonly reason: string
}> {}

/** One top-level data element: its tag, its VR and its value bytes, padding included. */
interface DataElement {
  /** `(group << 16) | element`, so numeric order is the order a data set is written in. */
  readonly tag: number
  /** The two-letter value representation, as written. */
  readonly vr: string
  /**
   * The value as written. For an undefined-length element, everything after
   * its header up to and including its Sequence Delimitation Item.
   */
  readonly value: Uint8Array
  /** Written with length `0xFFFFFFFF`, and delimited rather than counted. */
  readonly undefinedLength: boolean
}

/** A Part 10 file: its preamble, its file meta group and its data set. */
interface Part10File {
  /** The 128 bytes before `DICM`. */
  readonly preamble: Uint8Array
  /**
   * The file meta information (group `0002`), in tag order, without its group
   * length — {@link encode} counts that from the elements it writes.
   */
  readonly meta: readonly DataElement[]
  /** The data set's top-level elements, in the order they were read. */
  readonly dataSet: readonly DataElement[]
}

const PREAMBLE_LENGTH = 128
const DICM = [0x44, 0x49, 0x43, 0x4d] as const
const UNDEFINED_LENGTH = 0xffff_ffff

const META_GROUP = 0x0002
const META_GROUP_LENGTH_TAG = 0x0002_0000
const TRANSFER_SYNTAX_UID_TAG = 0x0002_0010

const ITEM_TAG = 0xfffe_e000
const ITEM_DELIMITATION_TAG = 0xfffe_e00d
const SEQUENCE_DELIMITATION_TAG = 0xfffe_e0dd

const EXPLICIT_VR_LITTLE_ENDIAN = '1.2.840.10008.1.2.1'

/**
 * The two JPIP Referenced Deflate syntaxes: under `1.2.840.10008.1.2.4.` like
 * the encapsulated ones, but their data set is deflated.
 */
const DEFLATED_JPIP_TRANSFER_SYNTAXES: ReadonlySet<string> = new Set([
  '1.2.840.10008.1.2.4.95',
  '1.2.840.10008.1.2.4.205',
])

/**
 * Whether a transfer syntax encodes its data set as Explicit VR Little
 * Endian: that syntax itself, and every encapsulated one — the JPEG family,
 * JPEG-LS, JPEG 2000, HTJ2K, MPEG, HEVC (`1.2.840.10008.1.2.4.*`, less the
 * deflated JPIP ones) and RLE (`1.2.840.10008.1.2.5`).
 */
const isExplicitVrLittleEndianDataSet = (transferSyntaxUid: string): boolean =>
  transferSyntaxUid === EXPLICIT_VR_LITTLE_ENDIAN ||
  (transferSyntaxUid.startsWith('1.2.840.10008.1.2.4.') &&
    !DEFLATED_JPIP_TRANSFER_SYNTAXES.has(transferSyntaxUid)) ||
  transferSyntaxUid === '1.2.840.10008.1.2.5'

/** The VRs PS3.5 Table 7.1-1 writes with two reserved bytes and a 32-bit length. */
const LONG_LENGTH_VRS: ReadonlySet<string> = new Set([
  'OB',
  'OD',
  'OF',
  'OL',
  'OV',
  'OW',
  'SQ',
  'SV',
  'UC',
  'UN',
  'UR',
  'UT',
  'UV',
])

/** The VRs with a 16-bit length (PS3.5 Table 7.1-2). */
const SHORT_LENGTH_VRS: ReadonlySet<string> = new Set([
  'AE',
  'AS',
  'AT',
  'CS',
  'DA',
  'DS',
  'DT',
  'FD',
  'FL',
  'IS',
  'LO',
  'LT',
  'PN',
  'SH',
  'SL',
  'SS',
  'ST',
  'TM',
  'UI',
  'UL',
  'US',
])

/** Whether an element's group is odd — a private data element (PS3.5 7.8). */
const isPrivate = (element: DataElement): boolean => (element.tag >>> 16) % 2 === 1

/** The tag in the `(gggg,eeee)` form the standard writes it in. */
const tagLabelOf = (tag: number): string => {
  const hex = tag.toString(16).toUpperCase().padStart(8, '0')
  return `(${hex.slice(0, 4)},${hex.slice(4)})`
}

/** A forward-only reader over the file's bytes, failing on a read past the end. */
class Cursor {
  readonly #view: DataView
  position: number

  constructor(
    readonly bytes: Uint8Array,
    position: number
  ) {
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    this.position = position
  }

  get atEnd(): boolean {
    return this.position >= this.bytes.length
  }

  #require(byteCount: number): void {
    if (this.position + byteCount > this.bytes.length) {
      throw new UnsupportedDicomFile({
        reason: `The file ends inside an element at byte ${this.position}.`,
      })
    }
  }

  uint16(): number {
    this.#require(2)
    const value = this.#view.getUint16(this.position, true)
    this.position += 2
    return value
  }

  uint32(): number {
    this.#require(4)
    const value = this.#view.getUint32(this.position, true)
    this.position += 4
    return value
  }

  tag(): number {
    const group = this.uint16()
    const element = this.uint16()
    return ((group << 16) | element) >>> 0
  }

  skip(byteCount: number): void {
    this.#require(byteCount)
    this.position += byteCount
  }
}

/**
 * Walk an undefined-length value — the items of a sequence or the fragments
 * of encapsulated Pixel Data — up to and including its Sequence Delimitation
 * Item.
 */
const skipDelimitedValue = (cursor: Cursor): void => {
  for (;;) {
    const tag = cursor.tag()
    const length = cursor.uint32()
    if (tag === SEQUENCE_DELIMITATION_TAG) return
    if (tag !== ITEM_TAG) {
      throw new UnsupportedDicomFile({
        reason: `Expected an item inside an undefined-length value, found ${tagLabelOf(tag)} at byte ${cursor.position - 8}.`,
      })
    }
    if (length === UNDEFINED_LENGTH) skipDelimitedItem(cursor)
    else cursor.skip(length)
  }
}

/** Walk an undefined-length item's elements up to and including its Item Delimitation Item. */
const skipDelimitedItem = (cursor: Cursor): void => {
  for (;;) {
    const start = cursor.position
    const tag = cursor.tag()
    if (tag === ITEM_DELIMITATION_TAG) {
      cursor.skip(4)
      return
    }
    cursor.position = start
    readElement(cursor)
  }
}

/** Read one Explicit VR Little Endian element at the cursor. */
const readElement = (cursor: Cursor): DataElement => {
  const start = cursor.position
  const tag = cursor.tag()
  const vr = String.fromCharCode(
    cursor.bytes[cursor.position] ?? 0,
    cursor.bytes[cursor.position + 1] ?? 0
  )
  cursor.skip(2)
  let length: number
  if (LONG_LENGTH_VRS.has(vr)) {
    cursor.skip(2)
    length = cursor.uint32()
  } else if (SHORT_LENGTH_VRS.has(vr)) {
    length = cursor.uint16()
  } else {
    throw new UnsupportedDicomFile({
      reason: `${tagLabelOf(tag)} at byte ${start} has no explicit VR; only an Explicit VR Little Endian data set is read.`,
    })
  }
  const valueStart = cursor.position
  if (length !== UNDEFINED_LENGTH) {
    cursor.skip(length)
    return {
      tag,
      vr,
      value: cursor.bytes.slice(valueStart, cursor.position),
      undefinedLength: false,
    }
  }
  if (vr === 'UN') {
    // An undefined-length UN holds its items in Implicit VR (PS3.5 6.2.2),
    // which this reader does not walk.
    throw new UnsupportedDicomFile({
      reason: `${tagLabelOf(tag)} is an undefined-length UN, whose items are Implicit VR.`,
    })
  }
  skipDelimitedValue(cursor)
  return { tag, vr, value: cursor.bytes.slice(valueStart, cursor.position), undefinedLength: true }
}

const textDecoder = new TextDecoder()

/** A UI value without its trailing null or space padding. */
const uidOf = (element: DataElement): string =>
  textDecoder.decode(element.value).replace(/[\0 ]+$/, '')

/** Read elements from the cursor while `continues` holds for the next tag. */
const readElementsWhile = (
  cursor: Cursor,
  continues: (nextTag: number) => boolean
): readonly DataElement[] => {
  const elements: DataElement[] = []
  while (!cursor.atEnd) {
    const next = new Cursor(cursor.bytes, cursor.position).tag()
    if (!continues(next)) break
    elements.push(readElement(cursor))
  }
  return elements
}

const decodeOrThrow = (bytes: Uint8Array): Part10File => {
  if (bytes.length < PREAMBLE_LENGTH + DICM.length) {
    throw new UnsupportedDicomFile({ reason: 'The file is too short to be a DICOM Part 10 file.' })
  }
  if (DICM.some((byte, index) => bytes[PREAMBLE_LENGTH + index] !== byte)) {
    throw new UnsupportedDicomFile({
      reason: 'No DICM prefix at byte 128; only a DICOM Part 10 file is read.',
    })
  }
  const cursor = new Cursor(bytes, PREAMBLE_LENGTH + DICM.length)
  const meta = readElementsWhile(cursor, (tag) => tag >>> 16 === META_GROUP).filter(
    (element) => element.tag !== META_GROUP_LENGTH_TAG
  )
  const transferSyntax = meta.find((element) => element.tag === TRANSFER_SYNTAX_UID_TAG)
  if (transferSyntax === undefined) {
    throw new UnsupportedDicomFile({
      reason: 'The file meta states no Transfer Syntax UID (0002,0010).',
    })
  }
  const transferSyntaxUid = uidOf(transferSyntax)
  if (!isExplicitVrLittleEndianDataSet(transferSyntaxUid)) {
    throw new UnsupportedDicomFile({
      reason: `Transfer syntax ${transferSyntaxUid} does not encode its data set as Explicit VR Little Endian.`,
    })
  }
  return {
    preamble: bytes.slice(0, PREAMBLE_LENGTH),
    meta,
    dataSet: readElementsWhile(cursor, () => true),
  }
}

/**
 * Read a Part 10 file's top-level element stream.
 *
 * @param bytes - The whole file, preamble included
 * @returns The file's elements, or why they cannot be read: no `DICM`
 *   prefix, a transfer syntax whose data set is not Explicit VR Little Endian,
 *   an element with no explicit VR, or a file that ends inside an element
 */
const decode = (bytes: Uint8Array): Either.Either<Part10File, UnsupportedDicomFile> => {
  try {
    return Either.right(decodeOrThrow(bytes))
  } catch (error) {
    if (error instanceof UnsupportedDicomFile) return Either.left(error)
    throw error
  }
}

/**
 * The bytes one element is written as: tag, VR, length, value.
 *
 * @remarks
 * Throws on an odd-length value, or one too long for its VR's 16-bit length:
 * every element comes from {@link decode} or a caller that pads its values, so
 * either is a bug in that caller, not a property of the file.
 */
const encodeElement = (element: DataElement): Uint8Array => {
  const long = LONG_LENGTH_VRS.has(element.vr)
  if (element.value.length % 2 === 1) {
    throw new Error(`${tagLabelOf(element.tag)} has an odd-length value; DICOM values are even.`)
  }
  if (!long && element.value.length > 0xffff) {
    throw new Error(`${tagLabelOf(element.tag)} ${element.vr} is longer than its 16-bit length.`)
  }
  const headerLength = long ? 12 : 8
  const bytes = new Uint8Array(headerLength + element.value.length)
  const view = new DataView(bytes.buffer)
  view.setUint16(0, element.tag >>> 16, true)
  view.setUint16(2, element.tag & 0xffff, true)
  bytes[4] = element.vr.charCodeAt(0)
  bytes[5] = element.vr.charCodeAt(1)
  const length = element.undefinedLength ? UNDEFINED_LENGTH : element.value.length
  if (long) view.setUint32(8, length, true)
  else view.setUint16(6, length, true)
  bytes.set(element.value, headerLength)
  return bytes
}

/** `parts` end to end in one buffer. */
const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.length
  }
  return bytes
}

/**
 * Write a Part 10 file: the preamble, `DICM`, the file meta group behind a
 * File Meta Information Group Length counted from it, then the data set.
 *
 * @remarks
 * Elements are written in the order given; a caller that edits a data set
 * keeps it in ascending tag order ({@link byTag}), as PS3.5 7.1 requires.
 */
const encode = (file: Part10File): Uint8Array => {
  const metaBody = concat(file.meta.map(encodeElement))
  const groupLength = new Uint8Array(4)
  new DataView(groupLength.buffer).setUint32(0, metaBody.length, true)
  return concat([
    file.preamble,
    Uint8Array.from(DICM),
    encodeElement({
      tag: META_GROUP_LENGTH_TAG,
      vr: 'UL',
      value: groupLength,
      undefinedLength: false,
    }),
    metaBody,
    ...file.dataSet.map(encodeElement),
  ])
}

/** Ascending tag order, the order PS3.5 7.1 writes a data set in. */
const byTag = (left: DataElement, right: DataElement): number => left.tag - right.tag

export { byTag, concat, decode, encode, isPrivate, tagLabelOf, UnsupportedDicomFile }
export type { DataElement, Part10File }
