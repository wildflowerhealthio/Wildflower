/**
 * Property tests for {@link toLoadFrom}.
 *
 * Pins the three load-bearing invariants:
 *  - the output `_tag` is the lowercase of the input `_tag`,
 *  - the payload (`uri` / `html`) round-trips verbatim,
 *  - `Html.baseUrl` falls back to `about:blank` only when undefined.
 */
import { fc, test as fcTest } from '@fast-check/jest'

import { FALLBACK_BASE_URL, toLoadFrom } from './to-load-from.ts'

describe('toLoadFrom', () => {
  fcTest.prop({ uri: fc.webUrl() })(
    'Uri: output _tag is lowercase of input and uri is preserved verbatim',
    ({ uri }) => {
      const out = toLoadFrom({ _tag: 'Uri', uri })
      expect(out._tag).toBe('uri')
      if (out._tag === 'uri') {
        expect(out.uri).toBe(uri)
      }
    }
  )

  fcTest.prop({ html: fc.string(), baseUrl: fc.webUrl() })(
    'Html with a defined baseUrl: output _tag is lowercase, payload preserved verbatim',
    ({ html, baseUrl }) => {
      const out = toLoadFrom({ _tag: 'Html', html, baseUrl })
      expect(out._tag).toBe('html')
      if (out._tag === 'html') {
        expect(out.html).toBe(html)
        expect(out.baseUrl).toBe(baseUrl)
      }
    }
  )

  fcTest.prop({ html: fc.string() })(
    'Html without baseUrl: baseUrl falls back to about:blank',
    ({ html }) => {
      const out = toLoadFrom({ _tag: 'Html', html })
      expect(out._tag).toBe('html')
      if (out._tag === 'html') {
        expect(out.html).toBe(html)
        expect(out.baseUrl).toBe(FALLBACK_BASE_URL)
        expect(out.baseUrl).toBe('about:blank')
      }
    }
  )
})
