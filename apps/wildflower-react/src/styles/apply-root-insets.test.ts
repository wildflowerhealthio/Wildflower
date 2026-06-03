import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test'

import { applyRootInsets } from './apply-root-insets.ts'

describe('applyRootInsets', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  test('writes the insets as CSS padding (top right bottom left) on #root', () => {
    applyRootInsets({ top: 47, bottom: 0, left: 8, right: 12 })
    const root = document.getElementById('root')
    expect(root?.style.paddingTop).toBe('47px')
    expect(root?.style.paddingRight).toBe('12px')
    expect(root?.style.paddingBottom).toBe('0px')
    expect(root?.style.paddingLeft).toBe('8px')
  })

  test('re-applying overwrites the previous padding rather than accumulating', () => {
    applyRootInsets({ top: 47, bottom: 0, left: 0, right: 0 })
    applyRootInsets({ top: 20, bottom: 0, left: 0, right: 0 })
    expect(document.getElementById('root')?.style.paddingTop).toBe('20px')
  })

  test('is a no-op when #root is absent', () => {
    document.body.innerHTML = ''
    expect(() => applyRootInsets({ top: 47, bottom: 0, left: 0, right: 0 })).not.toThrow()
  })
})
