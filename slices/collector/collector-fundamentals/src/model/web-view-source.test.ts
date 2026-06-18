import { Schema } from 'effect'
import { utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { UriSchema } from './web-view-source.ts'

const { expectRightToEqual, expectLeftToEqual } = utilityExpectations(expect)

describe('UriSchema', () => {
  it.each(['https://r4.smarthealthit.org/Patient/1', 'http://localhost:8080/fhir/Patient/1'])(
    'accepts the http(s) URI %s',
    (uri) => {
      const value = { _tag: 'Uri', uri } as const
      expectRightToEqual(Schema.decodeUnknownEither(UriSchema)(value), value)
    }
  )

  it.each([
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,<script>1</script>',
    'ftp://x/y',
    'tauri://localhost/x',
  ])('rejects the non-http(s) scheme %s', (uri) => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(UriSchema)({ _tag: 'Uri', uri }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })
})
