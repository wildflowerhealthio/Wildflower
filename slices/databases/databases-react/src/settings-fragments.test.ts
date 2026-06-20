import { describe, expect, test } from 'vite-plus/test'

import { databasesSettingsItemsFragment } from './settings-fragments.ts'

describe('databasesSettingsItemsFragment', () => {
  test('contributes one item to the unified settings menu', () => {
    // If the slice ever grows a second settings item, this assertion should be
    // expanded deliberately rather than silently — the unified /settings menu
    // treats fragment-declaration order as canonical.
    expect(databasesSettingsItemsFragment.length).toBe(1)
  })

  test('links to /settings/databases — the path mounted by the slice route subtree', () => {
    const [item] = databasesSettingsItemsFragment
    expect(item?.href).toBe('/settings/databases')
  })

  test('has a stable id usable as a React key', () => {
    const [item] = databasesSettingsItemsFragment
    expect(item?.id).toBe('databases')
  })
})
