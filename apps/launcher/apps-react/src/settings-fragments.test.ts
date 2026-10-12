import { describe, expect, test } from 'vite-plus/test'

import { appsSettingsItemsFragment } from './settings-fragments.ts'

describe('appsSettingsItemsFragment', () => {
  test('contributes the Apps row, then the Arrange home screen row', () => {
    // If the slice ever grows another settings item, this assertion should be
    // expanded deliberately rather than silently — the unified /settings menu
    // treats fragment-declaration order as canonical.
    expect(appsSettingsItemsFragment.map((item) => item.id)).toEqual(['apps', 'home-screen'])
  })

  test('links Apps to /settings/apps — the path mounted by the slice route subtree', () => {
    const [apps] = appsSettingsItemsFragment
    expect(apps?.href).toBe('/settings/apps')
  })

  test('links Arrange home screen to the home screen, in edit mode', () => {
    const [, homeScreen] = appsSettingsItemsFragment
    expect(homeScreen?.href).toBe('/home')
    expect(
      homeScreen !== undefined && 'search' in homeScreen ? homeScreen.search : undefined
    ).toEqual({ edit: true })
  })
})
