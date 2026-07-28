import { Schema } from 'effect'
import * as fc from 'fast-check'
import { Attachment } from 'fhir-r4/data-types'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'
import type { TraceBody } from 'web-trace-core'
import { arbitraries } from 'web-trace-core/test-helpers'

import {
  decodeText,
  formatJson,
  fromFhirAttachment,
  fromTraceBody,
  mediaTypeOf,
  previewKindFor,
} from './viewable-attachment.ts'

describe('fromTraceBody', () => {
  it('should carry a stored body through with its bytes', () => {
    // Arrange
    const body: TraceBody = {
      _tag: 'StoredBody',
      contentType: 'application/json',
      data: encodeBase64('{"ok":true}'),
      size: 11,
      hash: HASH,
    }

    // Act
    const attachment = fromTraceBody(body, 'https://portal.example.org/one')

    // Assert
    expect(attachment.data).toBe(encodeBase64('{"ok":true}'))
    expect(attachment.absence).toBeNull()
    expect(attachment.title).toBe('https://portal.example.org/one')
  })

  it('should keep a skipped body reported as skipped, with its size and hash', () => {
    // Arrange
    const body: TraceBody = {
      _tag: 'SkippedBody',
      contentType: 'video/mp4',
      size: 84_213_760,
      hash: HASH,
      reason: 'over the size cap',
    }

    // Act
    const attachment = fromTraceBody(body)

    // Assert — never an empty body; the trace is explicit about what it dropped
    expect(attachment.data).toBeNull()
    expect(attachment.size).toBe(84_213_760)
    expect(attachment.hash).toBe(HASH)
    expect(attachment.absence).toEqual({ _tag: 'SkippedAtCapture', reason: 'over the size cap' })
  })

  it('should always keep the size and hash a body recorded, stored or not', () => {
    fc.assert(
      fc.property(arbitraries(fc).body, (body) => {
        // Act
        const attachment = fromTraceBody(body)

        // Assert
        expect(attachment.size).toBe(body.size)
        expect(attachment.hash).toBe(body.hash)
        expect(attachment.contentType).toBe(body.contentType)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should always mark absence exactly when the bytes are absent', () => {
    fc.assert(
      fc.property(arbitraries(fc).body, (body) => {
        // Act
        const attachment = fromTraceBody(body)

        // Assert
        expect(attachment.absence === null).toBe(attachment.data !== null)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('fromFhirAttachment', () => {
  it('should carry inline data through', () => {
    // Act
    const attachment = fromFhirAttachment(
      fhirAttachment({ contentType: 'text/plain', data: encodeBase64('hello'), size: 5 })
    )

    // Assert
    expect(attachment.data).toBe(encodeBase64('hello'))
    expect(attachment.absence).toBeNull()
  })

  it('should report content held at a URL as by-reference, not as empty', () => {
    // Act
    const attachment = fromFhirAttachment(
      fhirAttachment({
        contentType: 'application/pdf',
        url: 'https://files.example.org/report.pdf',
      })
    )

    // Assert — the viewer names the location; fetching it would be network egress
    expect(attachment.absence).toEqual({
      _tag: 'ByReference',
      url: 'https://files.example.org/report.pdf',
    })
  })

  it('should report an attachment with neither data nor url as empty', () => {
    // Act
    const attachment = fromFhirAttachment(fhirAttachment({ contentType: 'application/pdf' }))

    // Assert
    expect(attachment.absence).toEqual({ _tag: 'Empty' })
  })

  it('should read a missing content type as unrecorded rather than inventing one', () => {
    // Act
    const attachment = fromFhirAttachment(fhirAttachment({}))

    // Assert
    expect(attachment.contentType).toBe('')
  })
})

describe('mediaTypeOf', () => {
  it('should drop parameters and lower-case the type', () => {
    // Act / Assert
    expect(mediaTypeOf('Application/JSON; charset=utf-8')).toBe('application/json')
  })
})

describe('previewKindFor', () => {
  it('should classify the types the viewer knows how to render', () => {
    // Act / Assert
    expect(previewKindFor('application/json')).toBe('json')
    expect(previewKindFor('application/fhir+json')).toBe('json')
    expect(previewKindFor('text/html; charset=utf-8')).toBe('text')
    expect(previewKindFor('application/xml')).toBe('text')
    expect(previewKindFor('image/png')).toBe('image')
  })

  it('should treat SVG as text, since rendering one would run what the page served', () => {
    // Act / Assert — an SVG can carry script and remote references
    expect(previewKindFor('image/svg+xml')).toBe('text')
  })

  it('should refuse to guess at an unrecognised type', () => {
    // Act / Assert
    expect(previewKindFor('application/octet-stream')).toBe('none')
    expect(previewKindFor('video/mp4')).toBe('none')
    expect(previewKindFor('')).toBe('none')
  })

  it('should always ignore parameters when classifying', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('application/json', 'text/html', 'image/png', 'application/octet-stream'),
        fc.string({ minLength: 1 }).filter((parameter) => !parameter.includes(';')),
        (mediaType, parameter) => {
          // Act / Assert
          expect(previewKindFor(`${mediaType};${parameter}`)).toBe(previewKindFor(mediaType))
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('decodeText', () => {
  it('should always recover the text a body was encoded from', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        // Act / Assert
        expect(decodeText(encodeBase64(text))).toBe(text)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should report undecodable content rather than raising', () => {
    // Act / Assert — a bad body is a fact to render, not a reason to fail the view
    expect(decodeText('not base64 !!!')).toBeNull()
  })
})

describe('formatJson', () => {
  it('should re-indent JSON', () => {
    // Act
    const formatted = formatJson('{"a":1,"b":[2,3]}')

    // Assert
    expect(formatted).toBe('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}')
  })

  it('should render a body labelled JSON that is not JSON as itself', () => {
    // Act / Assert — hiding the mismatch would hide what a collector author needs
    expect(formatJson('<html>not json</html>')).toBe('<html>not json</html>')
  })

  it('should always be idempotent on valid JSON', () => {
    fc.assert(
      fc.property(arbitraries(fc).jsonBodyValue, (value) => {
        // Arrange
        const once = formatJson(JSON.stringify(value))

        // Act / Assert
        expect(formatJson(once)).toBe(once)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

// Helpers

const HASH = 'RBNvo1WzZ4oRRq0W9+hknpT7T8If536DEMBg9hyq/4o='

const encodeBase64 = Schema.encodeSync(Schema.StringFromBase64)

const decodeAttachment = Schema.decodeSync(Attachment.Schema)

/**
 * A decoded FHIR `Attachment`, built by decoding wire JSON rather than by
 * hand-writing the decoded shape — so the fixture goes through the same schema
 * production does, brands and absent-field handling included.
 */
const fhirAttachment = (wire: {
  readonly contentType?: string
  readonly data?: string
  readonly url?: string
  readonly size?: number
}): Parameters<typeof fromFhirAttachment>[0] => decodeAttachment(wire)
