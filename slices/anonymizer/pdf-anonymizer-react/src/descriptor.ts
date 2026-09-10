import { DecodeFailure, type AnonymizerFormatDescriptor } from 'anonymizer-fundamentals'
import { Effect } from 'effect'
import type { PositionedTextDocument } from 'positioned-text'

import { extractPositionedText } from 'positioned-text-web'

const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])

const PDF_PARSE_ERROR = 'That file could not be read as a PDF.'

const startsWith = (bytes: Uint8Array, prefix: Uint8Array): boolean => {
  if (bytes.length < prefix.length) return false
  for (let i = 0; i < prefix.length; i += 1) {
    if (bytes[i] !== prefix[i]) return false
  }
  return true
}

const pdfDescriptor: AnonymizerFormatDescriptor<PositionedTextDocument> = {
  format: 'pdf',
  display: {
    title: 'PDF Document',
    description: 'A PDF document, extracted as anonymized positioned-text JSON.',
  },
  accept: ['.pdf', 'application/pdf'],
  detect: (file) => startsWith(file.bytes, PDF_MAGIC),
  decode: (file) =>
    Effect.tryPromise({
      try: () => extractPositionedText(file.bytes, file.fileName),
      catch: () => new DecodeFailure({ message: PDF_PARSE_ERROR }),
    }),
}

export { PDF_PARSE_ERROR, pdfDescriptor }
