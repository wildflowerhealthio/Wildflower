import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { matchesPin, parsePrebuiltConfig, renderStubPage, sha256Hex } from './prebuilt.ts'

const sha256Arb = fc.stringMatching(/^[0-9a-f]{64}$/)
const httpsUrlArb = fc.webUrl({ validSchemes: ['https'] })

describe('parsePrebuiltConfig', () => {
  it('should return null for an unpinned file', () => {
    expect(parsePrebuiltConfig({ pin: null })).toBeNull()
  })

  it('should accept any https URL with a 64-hex-char digest, normalising the hex to lower case', () => {
    fc.assert(
      fc.property(httpsUrlArb, sha256Arb, fc.boolean(), (url, sha256, upper) => {
        const written = upper ? sha256.toUpperCase() : sha256
        expect(parsePrebuiltConfig({ pin: { url, sha256: written } })).toStrictEqual({
          url,
          sha256,
        })
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should reject a pin whose URL is not https', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.webUrl({ validSchemes: ['http'] }), fc.string()),
        sha256Arb,
        (url, sha256) => {
          expect(() => parsePrebuiltConfig({ pin: { url, sha256 } })).toThrow(/pin\.url/)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should reject a digest that is not exactly 64 hex characters', () => {
    const badDigest = fc.oneof(
      fc.string().filter((s) => !/^[0-9a-fA-F]{64}$/.test(s)),
      fc.integer(),
      fc.constant(null)
    )
    fc.assert(
      fc.property(httpsUrlArb, badDigest, (url, sha256) => {
        expect(() => parsePrebuiltConfig({ pin: { url, sha256 } })).toThrow(/pin\.sha256/)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should reject documents without a pin field', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.anything().filter((v) => typeof v !== 'object' || v === null),
          fc.constant({})
        ),
        (value) => {
          expect(() => parsePrebuiltConfig(value)).toThrow(/"pin"/)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should accept the committed prebuilt.json', () => {
    const committed: unknown = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'prebuilt.json'), 'utf8')
    )
    expect(() => parsePrebuiltConfig(committed)).not.toThrow()
  })
})

describe('matchesPin', () => {
  it('should match bytes against their own digest and nothing else', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 1 }), fc.nat(), (bytes, flip) => {
        const pin = { url: 'https://example.test/a.tar.gz', sha256: sha256Hex(bytes) }
        expect(matchesPin(pin, bytes)).toBe(true)
        const corrupted = Uint8Array.from(bytes)
        const at = flip % corrupted.length
        corrupted[at] = (corrupted[at] ?? 0) ^ 0x01
        expect(matchesPin(pin, corrupted)).toBe(false)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('renderStubPage', () => {
  it('should name the pin file, HTML-escaped, in a complete document', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (pinPath) => {
        const page = renderStubPage(pinPath)
        expect(page.startsWith('<!doctype html>')).toBe(true)
        expect(page).toContain(
          pinPath
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
        )
        expect(page).not.toMatch(/<code>[^<]*[<>"][^<]*<\/code>/)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
