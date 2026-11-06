import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Effect, Option } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import * as Section from './section.ts'
import * as SectionedList from './sectioned-list.ts'

interface TestRow {
  readonly key: string
  readonly title: string
}

const listArbitrary: fc.Arbitrary<SectionedList.Type<TestRow>> = fc.record({
  sections: fc.array(
    fc.record({
      title: fc.string(),
      rows: fc.array(fc.record({ key: fc.string(), title: fc.string() })),
    })
  ),
})

const list: SectionedList.Type<TestRow> = {
  sections: [
    { title: 'First', rows: [{ key: 'k-0', title: 'Patient/a' }] },
    {
      title: 'Second',
      rows: [
        { key: 'k-1', title: 'Patient/b' },
        { key: 'k-2', title: 'Patient/c' },
      ],
    },
  ],
}

describe('SectionedList.rows', () => {
  it('should flatten the sections into one list, in section order', () => {
    expect(SectionedList.rows(list).map((row) => row.key)).toEqual(['k-0', 'k-1', 'k-2'])
  })

  it('property: flattening keeps every row exactly once, in order', () => {
    fc.assert(
      fc.property(listArbitrary, (all) => {
        expect(SectionedList.rows(all)).toEqual(all.sections.flatMap((section) => section.rows))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('SectionedList.map', () => {
  it('should give back the list itself when every row comes back as itself', () => {
    expect(SectionedList.map(list, (row) => row)).toBe(list)
  })

  it('should replace only the rows that changed, keeping every untouched row and section as itself', () => {
    const retitled = SectionedList.map(list, (row) =>
      row.key === 'k-2' ? { ...row, title: 'Patient C' } : row
    )

    expect(retitled).not.toBe(list)
    expect(retitled.sections[0]).toBe(list.sections[0])
    expect(retitled.sections[1]?.rows[0]).toBe(list.sections[1]?.rows[0])
    expect(retitled.sections[1]).toEqual({
      title: 'Second',
      rows: [
        { key: 'k-1', title: 'Patient/b' },
        { key: 'k-2', title: 'Patient C' },
      ],
    })
  })

  it('property: the mapped rows are the rows mapped, sections and titles kept', () => {
    fc.assert(
      fc.property(listArbitrary, (all) => {
        const mapped = SectionedList.map(all, (row) => row.key)

        expect(SectionedList.rows(mapped)).toEqual(SectionedList.rows(all).map((row) => row.key))
        expect(mapped.sections.map((section) => section.title)).toEqual(
          all.sections.map((section) => section.title)
        )
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('SectionedList.filterMap', () => {
  it('should keep the values of the rows kept and drop a section left empty', () => {
    const kept = SectionedList.filterMap(list, (row) =>
      row.key === 'k-0' ? Option.none() : Option.some(row.key)
    )

    expect(kept).toEqual({ sections: [{ title: 'Second', rows: ['k-1', 'k-2'] }] })
  })
})

describe('SectionedList.filter', () => {
  it('should keep the rows the predicate holds for and drop a section left empty', () => {
    expect(SectionedList.filter(list, (row) => row.key === 'k-2')).toEqual({
      sections: [{ title: 'Second', rows: [{ key: 'k-2', title: 'Patient/c' }] }],
    })
  })
})

describe('SectionedList.forEach', () => {
  it('should run the effect over every row, keeping section and row order', () => {
    const keys = Effect.runSync(SectionedList.forEach(list, (row) => Effect.succeed(row.key)))

    expect(keys).toEqual({
      sections: [
        { title: 'First', rows: ['k-0'] },
        { title: 'Second', rows: ['k-1', 'k-2'] },
      ],
    })
  })
})

describe('SectionedList.groupBy', () => {
  it('should section rows by title in the order each title first appears', () => {
    const grouped = SectionedList.groupBy(
      [
        { url: 'b', key: 'k-0' },
        { url: '2', key: 'k-1' },
        { url: 'b', key: 'k-2' },
        { url: '1', key: 'k-3' },
      ],
      (row) => row.url
    )

    expect(grouped.sections.map(({ title, rows }) => [title, rows.map((row) => row.key)])).toEqual([
      ['b', ['k-0', 'k-2']],
      ['2', ['k-1']],
      ['1', ['k-3']],
    ])
  })
})

describe('SectionedList.concatenate', () => {
  it('should keep both lists’ sections in order, never merging two that share a title', () => {
    const first = SectionedList.make([Section.make('Same', ['a'])])
    const second = SectionedList.make([Section.make('Same', ['b'])])

    expect(SectionedList.concatenate(first, second)).toEqual({
      sections: [
        { title: 'Same', rows: ['a'] },
        { title: 'Same', rows: ['b'] },
      ],
    })
    expect(SectionedList.concatenateAll([first, SectionedList.empty(), second])).toEqual(
      SectionedList.concatenate(first, second)
    )
  })

  it('should put a prepended section first and an appended one last', () => {
    const around = SectionedList.append(
      SectionedList.prepend(
        SectionedList.make([Section.make('Middle', ['m'])]),
        Section.make('First', ['f'])
      ),
      Section.make('Last', ['l'])
    )

    expect(around.sections.map((section) => section.title)).toEqual(['First', 'Middle', 'Last'])
  })
})
