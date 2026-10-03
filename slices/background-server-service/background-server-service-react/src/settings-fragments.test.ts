import { describe, expect, it } from 'vite-plus/test'

import { backgroundServerServiceSettingsItemsFragment } from './settings-fragments.ts'

describe('backgroundServerServiceSettingsItemsFragment', () => {
  it('should contribute one row, linking to the page this slice mounts', () => {
    // Assert
    expect(backgroundServerServiceSettingsItemsFragment).toEqual([
      expect.objectContaining({ id: 'server', href: '/settings/server' }),
    ])
  })
})
