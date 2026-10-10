import { describe, expect, test } from 'vite-plus/test'

import { pointSeriesOf } from './arbitraries.test-helpers.ts'
import type * as PointSeries from './point-series.ts'
import * as SeriesId from './series-id.ts'
import * as SeriesSource from './series-source.ts'

/** A minimal source over plain numbers, keyed by one name field. */
const definition: SeriesSource.SeriesSource<readonly number[], string, PointSeries.PointSeries> = {
  name: 'numbers',
  idPrefix: 'n',
  groups: [{ id: 'all', label: 'All' }],
  read: (values) => ({
    series: values.length === 0 ? [] : [pointSeriesOf([])],
    undated: 0,
    dropped: 0,
  }),
  seriesIdOf: (name) => SeriesId.fromFields('n', [name]),
  parseSeriesId: (id) => SeriesId.toFields('n', id)?.[0] ?? null,
  groupIdOf: () => 'all',
}

describe('SeriesSource.make', () => {
  test('keeps every member of the definition', () => {
    const source = SeriesSource.make(definition)
    expect(source.name).toBe('numbers')
    expect(source.idPrefix).toBe('n')
    expect(source.groups).toEqual(definition.groups)
    expect(source.read).toBe(definition.read)
    expect(source.seriesIdOf).toBe(definition.seriesIdOf)
    expect(source.parseSeriesId).toBe(definition.parseSeriesId)
    expect(source.groupIdOf).toBe(definition.groupIdOf)
  })

  test('the result is frozen and independent of the definition it was made from', () => {
    const groups = [{ id: 'all', label: 'All' }]
    const source = SeriesSource.make({ ...definition, groups })
    groups.push({ id: 'late', label: 'Late' })
    expect(source.groups).toHaveLength(1)
    expect(Object.isFrozen(source)).toBe(true)
    expect(Object.isFrozen(source.groups)).toBe(true)
  })

  test('drops properties the descriptor does not declare', () => {
    const definitionWithExtra = { ...definition, extra: true }
    const source = SeriesSource.make(definitionWithExtra)
    expect(Object.keys(source).toSorted()).toEqual(
      ['groupIdOf', 'groups', 'idPrefix', 'name', 'parseSeriesId', 'read', 'seriesIdOf'].toSorted()
    )
  })
})
