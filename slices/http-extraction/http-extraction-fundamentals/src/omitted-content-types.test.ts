import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import type * as HttpResponse from './http-response.ts'
import {
  contentTypeOf,
  isOmittedContentType,
  UNKNOWN_CONTENT_TYPE,
} from './omitted-content-types.ts'

const withContentType = (value: string): HttpResponse.Headers => [['content-type', value]]

/**
 * The maintainer's omit rule as a table: page furniture out, evidence in. This
 * is the contract `collector-fundamentals`' run recorder and the browser
 * extension both apply, so a change here changes what every recording
 * contains — add a row rather than relaxing one.
 */
describe('isOmittedContentType', () => {
  it.each([
    'text/javascript',
    'application/javascript',
    'application/ecmascript',
    'text/jscript',
    'text/css',
    'image/png',
    'image/svg+xml',
    'font/woff2',
    'audio/mpeg',
    'video/mp4',
  ])('omits %s', (contentType) => {
    expect(isOmittedContentType(withContentType(contentType))).toBe(true)
  })

  it.each([
    'application/fhir+json',
    'application/json',
    'text/html',
    'text/plain',
    'application/xml',
    'application/pdf',
    'application/octet-stream',
    // A subtype that merely *contains* an omitted word is not an omitted type:
    // the match is on the whole media type, or on a `type/` prefix.
    'application/vnd.image+json',
    'text/javascript-source-map',
  ])('keeps %s', (contentType) => {
    expect(isOmittedContentType(withContentType(contentType))).toBe(false)
  })

  it('keeps a response with no content-type at all', () => {
    expect(isOmittedContentType([])).toBe(false)
    expect(isOmittedContentType([['x-request-id', 'abc']])).toBe(false)
  })

  it('ignores header-name case and content-type parameters', () => {
    expect(isOmittedContentType([['Content-Type', 'TEXT/CSS; charset=utf-8']])).toBe(true)
    expect(isOmittedContentType([['CONTENT-TYPE', 'application/fhir+json; charset=utf-8']])).toBe(
      false
    )
  })

  it('is decided by the content type alone, whatever the URL suggests', () => {
    // A `.js` path served as JSON is evidence; an API path served as a script
    // is furniture. The rule never sees the URL, and these two rows are why.
    expect(isOmittedContentType(withContentType('application/json'))).toBe(false)
    expect(isOmittedContentType(withContentType('text/javascript'))).toBe(true)
  })

  it('agrees with contentTypeOf on every generated header set', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.string({ minLength: 1 }), fc.string()), { maxLength: 6 }),
        (headers) => {
          // The predicate is a pure function of the type `contentTypeOf` reads —
          // no second parsing rule can drift in behind it.
          expect(isOmittedContentType(headers)).toBe(
            isOmittedContentType(withContentType(contentTypeOf(headers)))
          )
        }
      ),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })
})

describe('contentTypeOf', () => {
  it('takes the first content-type, lower-cased, parameters stripped', () => {
    expect(
      contentTypeOf([
        ['Content-Type', 'Application/FHIR+JSON; charset=UTF-8'],
        ['content-type', 'text/css'],
      ])
    ).toBe('application/fhir+json')
  })

  it.each([[[]], [[['content-type', '']] as const], [[['content-type', '   ; x=1']] as const]])(
    'falls back to the unknown type for %j',
    (headers) => {
      expect(contentTypeOf(headers as HttpResponse.Headers)).toBe(UNKNOWN_CONTENT_TYPE)
    }
  )
})
