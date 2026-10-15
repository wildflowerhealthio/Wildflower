import { Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { recognizePortal } from './recognize-portal.ts'
import { Specificity } from './specificity.ts'
import * as UrlMatch from './url-match.ts'

const SYSTEM = 'https://portal.example/system'

describe('recognizePortal', () => {
  describe('over a RegExp', () => {
    const tryRecognize = recognizePortal(/^https:\/\/portal\.example\/rx(?:\?|$)/, SYSTEM)

    it('claims a matching URL at the portal tier under the given system', () => {
      expect(tryRecognize('https://portal.example/rx', Option.some('GET'))).toEqual(
        Option.some({ specificity: Specificity.PORTAL, source: { system: SYSTEM } })
      )
    })

    it('claims a matching URL whatever the method', () => {
      expect(Option.isSome(tryRecognize('https://portal.example/rx', Option.none()))).toBe(true)
    })

    it('is None for a URL the pattern does not match', () => {
      expect(tryRecognize('https://portal.example/other', Option.some('GET'))).toEqual(
        Option.none()
      )
    })
  })

  describe('over a UrlMatcher', () => {
    const tryRecognize = recognizePortal(
      UrlMatch.make({ verb: ['GET'], segments: [UrlMatch.literal('rx')] }),
      SYSTEM
    )

    it('claims a matching URL under a declared verb', () => {
      expect(tryRecognize('https://portal.example/rx', Option.some('GET'))).toEqual(
        Option.some({ specificity: Specificity.PORTAL, source: { system: SYSTEM } })
      )
    })

    it("is None under a verb the matcher doesn't declare", () => {
      expect(tryRecognize('https://portal.example/rx', Option.some('POST'))).toEqual(Option.none())
    })
  })
})
