import { Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { FhirResourceSchema, type FhirResource } from './fhir-resource.ts'
import { ResourceAttachments } from './index.ts'

/**
 * Covers the attachment walk: which `url`s it reaches, at any depth, and that
 * nothing else changes.
 */

const decodeResource = Schema.decodeUnknownSync(FhirResourceSchema)

const EXTENSION_URL = 'https://source.example/extension/scan-kind'

/**
 * A DocumentReference with three attachments, one of them with no `url`, and
 * an extension, whose `url` is no attachment's.
 */
const document = decodeResource({
  resourceType: 'DocumentReference',
  status: 'current',
  extension: [{ url: EXTENSION_URL, valueString: 'scan' }],
  content: [
    { attachment: { contentType: 'application/pdf', url: 'Binary/doc-1' } },
    { attachment: { contentType: 'application/pdf', data: 'JVBERi0=' } },
    { attachment: { contentType: 'image/png', url: 'https://source.example/scan.png' } },
  ],
})

/** Every `url` of a DocumentReference's attachments, in content order. */
const attachmentUrlsOf = (resource: FhirResource): readonly (string | null)[] => {
  if (resource.resourceType !== 'DocumentReference') throw new Error('expected a DocumentReference')
  return resource.content.map(({ attachment }) => attachment.url)
}

describe('ResourceAttachments.mapUrls', () => {
  it('rewrites the url of every attachment, nested in a list, and leaves one with no url', () => {
    const rewritten = ResourceAttachments.mapUrls(document, (url) => `rewritten:${url}`)

    expect(attachmentUrlsOf(rewritten)).toEqual([
      'rewritten:Binary/doc-1',
      null,
      'rewritten:https://source.example/scan.png',
    ])
  })

  it("leaves a url that is no attachment's, an extension's", () => {
    const rewritten = ResourceAttachments.mapUrls(document, (url) => `rewritten:${url}`)

    expect(rewritten.extension).toEqual(document.extension)
    expect(rewritten.extension[0]?.url).toBe(EXTENSION_URL)
  })

  it('gives back the resource itself when the rewrite changes no url', () => {
    expect(ResourceAttachments.mapUrls(document, (url) => url)).toBe(document)
  })
})
