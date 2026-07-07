import { describe, expect, test } from 'vite-plus/test'

import type { AppEntry } from '../../../queries.ts'
import { reorderApps } from './-reorder.ts'

const makeApp = (id: string, enabled = true): AppEntry => ({
  id,
  name: id,
  enabled,
  provenance: 'cloud',
  localOnly: false,
  smart: false,
  requiresTunnel: false,
  removable: true,
})

const apps: readonly AppEntry[] = ['a', 'b', 'c', 'd'].map((id) => makeApp(id))
const ids = (list: readonly AppEntry[] | null): readonly string[] | null =>
  list === null ? null : list.map((app) => app.id)

describe('reorderApps', () => {
  test('moving a tile down reorders the full list', () => {
    // `a` lands where `c` was (index 2); `b`/`c` shift up to fill the gap.
    expect(ids(reorderApps(apps, 'a', 'c'))).toEqual(['b', 'c', 'a', 'd'])
  })

  test('moving a tile up reorders the full list', () => {
    expect(ids(reorderApps(apps, 'd', 'b'))).toEqual(['a', 'd', 'b', 'c'])
  })

  test('a drop back onto the origin is a no-op (null, no write)', () => {
    expect(reorderApps(apps, 'b', 'b')).toBeNull()
  })

  test('an unknown active/over id is a no-op (null, no write)', () => {
    expect(reorderApps(apps, 'missing', 'b')).toBeNull()
    expect(reorderApps(apps, 'a', 'missing')).toBeNull()
  })

  test('operates over the full list, including disabled apps', () => {
    // The list the homescreen reorders is the *full* registry (a disabled `b`
    // included), so the result carries every id — the caller PUTs the whole
    // thing and the server renumbers `position` densely.
    const full: readonly AppEntry[] = [makeApp('a'), makeApp('b', false), makeApp('c')]
    expect(ids(reorderApps(full, 'a', 'c'))).toEqual(['b', 'c', 'a'])
  })
})
