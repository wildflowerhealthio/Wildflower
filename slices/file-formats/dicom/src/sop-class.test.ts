import { describe, expect, it } from 'vite-plus/test'

import * as SopClass from './sop-class.ts'

describe('SopClass.name', () => {
  it('names the common image storage classes', () => {
    expect(SopClass.name('1.2.840.10008.5.1.4.1.1.2')).toBe('CT Image Storage')
    expect(SopClass.name('1.2.840.10008.5.1.4.1.1.4')).toBe('MR Image Storage')
  })

  it('names the non-image classes that explain an empty viewer', () => {
    expect(SopClass.name('1.2.840.10008.5.1.4.1.1.88.11')).toBe('Basic Text SR Storage')
    expect(SopClass.name('1.2.840.10008.5.1.4.1.1.11.1')).toBe(
      'Grayscale Softcopy Presentation State Storage'
    )
    expect(SopClass.name('1.2.840.10008.5.1.4.1.1.104.1')).toBe('Encapsulated PDF Storage')
  })

  it('returns undefined for an unknown UID rather than guessing', () => {
    expect(SopClass.name('1.2.840.10008.5.1.4.1.1.999')).toBeUndefined()
    expect(SopClass.name('')).toBeUndefined()
  })

  it('is not fooled by inherited Object properties', () => {
    expect(SopClass.name('constructor')).toBeUndefined()
    expect(SopClass.name('valueOf')).toBeUndefined()
  })
})
