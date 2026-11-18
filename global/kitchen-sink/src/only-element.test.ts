import { Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { onlyElement } from './index.ts'

describe('onlyElement', () => {
  it('is None for an empty array', () => {
    expect(onlyElement([])).toEqual(Option.none())
  })

  it('is the element of an array holding one', () => {
    expect(onlyElement(['a'])).toEqual(Option.some('a'))
  })

  it('is None for an array holding several', () => {
    expect(onlyElement(['a', 'b'])).toEqual(Option.none())
  })
})
