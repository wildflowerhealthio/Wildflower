import { Schema } from 'effect'
import { PositionedTextDocument, anonymizedJsonFileName } from 'pdf-anonymizer-core'

const JSON_MEDIA_TYPE = 'application/json'

const encodeDoc = Schema.encodeSync(PositionedTextDocument)

const positionedTextBlob = (doc: PositionedTextDocument): Blob =>
  new Blob([JSON.stringify(encodeDoc(doc), null, 2)], { type: JSON_MEDIA_TYPE })

const downloadBlob = (blob: Blob, fileName: string): void => {
  const objectUrl = URL.createObjectURL(blob)
  try {
    const anchor = document.createElement('a')
    anchor.href = objectUrl
    anchor.download = fileName
    anchor.rel = 'noopener'
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

export { anonymizedJsonFileName, downloadBlob, positionedTextBlob }
