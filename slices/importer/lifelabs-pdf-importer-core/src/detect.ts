/**
 * Cheap syntactic identification of a LifeLabs PDF: either the file name ends
 * in `.pdf`, or the bytes start with the PDF magic `%PDF-`.
 *
 * @remarks
 * The full recognition — is this a LifeLabs report? — runs in
 * {@link decodeLifeLabsPdf}; the picker calls every registered format's
 * `detect` on every drop, so this must stay a byte-shape sniff rather than a
 * parse. The magic-bytes test wins first, since a `.pdf` name is only a hint
 * and the extension is unreliable in shared archives. Matches the anonymizer
 * PDF descriptor's `detect` by construction — a PDF that anonymizes and then
 * re-imports is recognized as PDF twice.
 *
 * @packageDocumentation
 */

const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])

const startsWithPdfMagic = (bytes: Uint8Array): boolean => {
  if (bytes.length < PDF_MAGIC.length) return false
  for (let i = 0; i < PDF_MAGIC.length; i += 1) if (bytes[i] !== PDF_MAGIC[i]) return false
  return true
}

/**
 * `FileImporterDescriptor.detect` for the LifeLabs PDF format: `%PDF-` magic
 * bytes or an extension of `.pdf`.
 */
const detectLifeLabsPdf = (fileBytes: Uint8Array, fileName: string): boolean =>
  startsWithPdfMagic(fileBytes) || fileName.toLowerCase().endsWith('.pdf')

export { detectLifeLabsPdf, PDF_MAGIC, startsWithPdfMagic }
