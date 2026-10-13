import { describe, expect, test } from 'vite-plus/test'

import { authorizationSettingsItemsFragment } from './settings-fragments.ts'

describe('authorizationSettingsItemsFragment', () => {
  test('contributes one item to the unified settings menu', () => {
    // Only the index landing gets a top-level menu entry. The request
    // list / request detail / approved-app detail screens are deep-linked
    // from <AccessIndexScreen /> and don't show up directly in /settings.
    expect(authorizationSettingsItemsFragment.length).toBe(1)
  })

  test('links to /settings/gatekeeper — the index path mounted by authorizationSettingsRoutesFragment', () => {
    const [item] = authorizationSettingsItemsFragment
    expect(item?.href).toBe('/settings/gatekeeper')
  })

  test('has a stable id usable as a React key', () => {
    const [item] = authorizationSettingsItemsFragment
    expect(item?.id).toBe('gatekeeper')
  })
})
