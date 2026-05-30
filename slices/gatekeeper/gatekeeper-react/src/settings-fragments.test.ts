import { describe, expect, test } from 'vite-plus/test'

import { gatekeeperSettingsItemsFragment } from './settings-fragments.ts'

describe('gatekeeperSettingsItemsFragment', () => {
  test('contributes one item to the unified settings menu', () => {
    // Only the index landing gets a top-level menu entry. The request
    // list / request detail / approved-app detail screens are deep-linked
    // from <AccessIndexScreen /> and don't show up directly in /settings.
    expect(gatekeeperSettingsItemsFragment.length).toBe(1)
  })

  test('links to /settings/gatekeeper — the index path mounted by gatekeeperSettingsRoutesFragment', () => {
    const [item] = gatekeeperSettingsItemsFragment
    expect(item?.href).toBe('/settings/gatekeeper')
  })

  test('has a stable id usable as a React key', () => {
    const [item] = gatekeeperSettingsItemsFragment
    expect(item?.id).toBe('gatekeeper')
  })
})
