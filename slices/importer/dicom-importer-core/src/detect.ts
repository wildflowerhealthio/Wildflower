/**
 * Cheap syntactic identification of a DICOM file: the `DICM` magic at byte
 * offset 128 (the standard preamble), or a `.dcm` extension fallback for files
 * without a preamble.
 *
 * @remarks
 * The picker calls every registered format's `detect` on every drop, so this
 * must stay a byte-shape sniff rather than a parse. The magic-bytes test wins
 * first since the extension is only a hint; the `DICM` prefix is defined by
 * the DICOM PS3.10 standard as four ASCII bytes at offset 128, following a
 * 128-byte preamble that applications may use for any purpose (or fill with
 * zero). A file shorter than 132 bytes cannot carry the magic.
 *
 * @packageDocumentation
 */

const DICM_MAGIC_OFFSET = 128
const DICM_MAGIC = new Uint8Array([0x44, 0x49, 0x43, 0x4d])

const hasDicmMagic = (bytes: Uint8Array): boolean => {
  if (bytes.length < DICM_MAGIC_OFFSET + DICM_MAGIC.length) return false
  for (let i = 0; i < DICM_MAGIC.length; i += 1) {
    if (bytes[DICM_MAGIC_OFFSET + i] !== DICM_MAGIC[i]) return false
  }
  return true
}

/**
 * `FileImporter`'s `detect` for the DICOM format: `DICM` at byte offset
 * 128 or an extension of `.dcm`.
 */
const detectDicom = (fileBytes: Uint8Array, fileName: string): boolean =>
  hasDicmMagic(fileBytes) || fileName.toLowerCase().endsWith('.dcm')

export { detectDicom, DICM_MAGIC, DICM_MAGIC_OFFSET, hasDicmMagic }
