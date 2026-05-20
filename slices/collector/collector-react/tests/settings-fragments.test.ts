import { describe, expect, test } from 'vite-plus/test'

import { collectorSettingsItemsFragment } from '../src/settings-fragments.ts'

describe('collectorSettingsItemsFragment', () => {
  test('contributes one item to the unified settings menu', () => {
    expect(collectorSettingsItemsFragment.length).toBe(1)
  })

  test('links to /settings/collector — the index path mounted by collectorSettingsRoutesFragment', () => {
    const [item] = collectorSettingsItemsFragment
    expect(item?.href).toBe('/settings/collector')
  })

  test('has a stable id usable as a React key', () => {
    const [item] = collectorSettingsItemsFragment
    expect(item?.id).toBe('collector')
  })
})
