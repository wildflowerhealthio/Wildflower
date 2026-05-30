import { describe, expect, test } from 'vite-plus/test'

import { tunnelSettingsItemsFragment } from './settings-fragments.ts'

describe('tunnelSettingsItemsFragment', () => {
  test('contributes one item to the unified settings menu', () => {
    // If the slice ever grows a second settings item, this assertion
    // should be expanded deliberately rather than silently — the unified
    // /settings menu treats fragment-declaration order as canonical.
    expect(tunnelSettingsItemsFragment.length).toBe(1)
  })

  test('links to /settings/tunnel — the path mounted by tunnelSettingsRoutesFragment', () => {
    const [item] = tunnelSettingsItemsFragment
    expect(item?.href).toBe('/settings/tunnel')
  })

  test('has a stable id usable as a React key', () => {
    const [item] = tunnelSettingsItemsFragment
    expect(item?.id).toBe('tunnel')
  })
})
