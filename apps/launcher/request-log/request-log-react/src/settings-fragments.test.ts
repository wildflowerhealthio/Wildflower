import { describe, expect, test } from 'vite-plus/test'

import { requestLogSettingsItemsFragment } from './settings-fragments.ts'

describe('requestLogSettingsItemsFragment', () => {
  test('contributes one item to the unified settings menu', () => {
    // If the slice ever grows a second settings item, this assertion should be
    // expanded deliberately rather than silently — the unified /settings menu
    // treats fragment-declaration order as canonical.
    expect(requestLogSettingsItemsFragment.length).toBe(1)
  })

  test('links to /settings/requests — the path the slice route mounts', () => {
    const [item] = requestLogSettingsItemsFragment
    expect(item?.href).toBe('/settings/requests')
  })

  test('has a stable id usable as a React key', () => {
    const [item] = requestLogSettingsItemsFragment
    expect(item?.id).toBe('requests')
  })
})
