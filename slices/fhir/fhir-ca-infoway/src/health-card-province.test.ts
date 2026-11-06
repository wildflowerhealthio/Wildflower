import { describe, expect, it } from 'vite-plus/test'

import { HealthCardProvince } from './index.ts'

describe('HealthCardProvince', () => {
  it('names every province it lists', () => {
    expect(HealthCardProvince.all.map((province) => HealthCardProvince.names[province])).toEqual([
      'Ontario',
      'British Columbia',
      'Other province',
    ])
  })

  it('reads back a listed province and refuses any other code', () => {
    expect(HealthCardProvince.all.filter(HealthCardProvince.is)).toEqual(['ON', 'BC', 'Other'])
    expect(['QC', 'on', 'other', ''].filter(HealthCardProvince.is)).toEqual([])
  })
})
