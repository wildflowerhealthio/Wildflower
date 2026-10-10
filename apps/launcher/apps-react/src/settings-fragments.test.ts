import { describe, expect, test } from 'vite-plus/test'

import { appsSettingsItemsFragment } from './settings-fragments.ts'

describe('appsSettingsItemsFragment', () => {
  test('contributes one item to the unified settings menu', () => {
    // If the slice ever grows a second settings item, this assertion should be
    // expanded deliberately rather than silently — the unified /settings menu
    // treats fragment-declaration order as canonical.
    expect(appsSettingsItemsFragment.length).toBe(1)
  })

  test('links to /settings/apps — the path mounted by the slice route subtree', () => {
    const [item] = appsSettingsItemsFragment
    expect(item?.href).toBe('/settings/apps')
  })

  test('has a stable id usable as a React key', () => {
    const [item] = appsSettingsItemsFragment
    expect(item?.id).toBe('apps')
  })
})
