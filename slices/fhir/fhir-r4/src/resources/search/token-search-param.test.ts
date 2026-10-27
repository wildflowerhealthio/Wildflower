import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Array, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { IdentifierAndReference } from '../../data-types/index.ts'
import * as TokenSearchParam from './token-search-param.ts'

const RUNS = numRunsFor({ base: 200 })

const qualified = (
  system: string,
  value: string
): IdentifierAndReference.QualifiedIdentifierType => {
  const identifier = Schema.decodeUnknownSync(IdentifierAndReference.IdentifierSchema)({
    system,
    value,
  })
  if (!IdentifierAndReference.isQualifiedIdentifier(identifier)) throw new Error('unreachable')
  return identifier
}

/** `escaped` read back as the server reads it: every backslash taken with the character after it. */
const unescape = (escaped: string): string => escaped.replaceAll(/\\(.)/gsu, '$1')

describe('TokenSearchParam.escape', () => {
  it('escapes each of the four reserved characters and nothing else', () => {
    expect(TokenSearchParam.escape('a,b|c$d\\e f')).toBe('a\\,b\\|c\\$d\\\\e f')
  })

  it('property: leaves no reserved character unescaped, and the server reads the original back', () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const escaped = TokenSearchParam.escape(raw)
        expect(escaped.replaceAll(/\\./gsu, '')).not.toMatch(/[,$|\\]/u)
        expect(unescape(escaped)).toBe(raw)
      }),
      { numRuns: RUNS }
    )
  })
})

describe('TokenSearchParam.fromQualifiedIdentifier', () => {
  it('writes system|value with both halves escaped', () => {
    expect(
      TokenSearchParam.fromQualifiedIdentifier(qualified('https://a.example/id,$', 'a,b|c$d\\e'))
    ).toBe('https://a.example/id\\,\\$|a\\,b\\|c\\$d\\\\e')
  })
})

describe('TokenSearchParam.anyOf', () => {
  it('joins tokens with the comma the server reads as "or"', () => {
    expect(
      TokenSearchParam.anyOf(
        Array.make(
          TokenSearchParam.fromQualifiedIdentifier(qualified('https://a.example/id', '1')),
          TokenSearchParam.fromQualifiedIdentifier(qualified('https://b.example/id', '2'))
        )
      )
    ).toBe('https://a.example/id|1,https://b.example/id|2')
  })
})
