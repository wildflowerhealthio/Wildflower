import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import * as StringSearchParam from './string-search-param.ts'

const RUNS = numRunsFor({ base: 200 })

/** `escaped` read back as the server reads it: every backslash taken with the character after it. */
const unescape = (escaped: string): string => escaped.replaceAll(/\\(.)/gsu, '$1')

describe('StringSearchParam.escape', () => {
  it('escapes the comma that would otherwise split one family into two', () => {
    expect(StringSearchParam.escape('Smith, Jr')).toBe('Smith\\, Jr')
  })

  it('escapes each of the four reserved characters and nothing else', () => {
    expect(StringSearchParam.escape("a,b|c$d\\e O'Brien")).toBe("a\\,b\\|c\\$d\\\\e O'Brien")
  })

  it('property: leaves no reserved character unescaped, and the server reads the original back', () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const escaped = StringSearchParam.escape(raw)
        expect(escaped.replaceAll(/\\./gsu, '')).not.toMatch(/[,$|\\]/u)
        expect(unescape(escaped)).toBe(raw)
      }),
      { numRuns: RUNS }
    )
  })
})

describe('StringSearchParam.anyOf', () => {
  it('escapes each value, then joins them with the commas that OR them', () => {
    expect(StringSearchParam.anyOf(['brown', 'smith, jr'])).toBe('brown,smith\\, jr')
  })
})
