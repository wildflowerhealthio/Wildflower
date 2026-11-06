import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Effect, Option } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import * as Sectioned from './sectioned.ts'

interface Entry {
  readonly key: string
  readonly title: string
}

const sectionedArbitrary: fc.Arbitrary<Sectioned.Type<Entry>> = fc.record({
  sections: fc.array(
    fc.record({
      title: fc.string(),
      entries: fc.array(fc.record({ key: fc.string(), title: fc.string() })),
    })
  ),
})

const sectioned: Sectioned.Type<Entry> = {
  sections: [
    { title: 'First', entries: [{ key: 'k-0', title: 'Patient/a' }] },
    {
      title: 'Second',
      entries: [
        { key: 'k-1', title: 'Patient/b' },
        { key: 'k-2', title: 'Patient/c' },
      ],
    },
  ],
}

describe('Sectioned.entries', () => {
  it('should flatten the sections into one list, in section order', () => {
    expect(Sectioned.entries(sectioned).map((entry) => entry.key)).toEqual(['k-0', 'k-1', 'k-2'])
  })

  it('property: flattening keeps every entry exactly once, in order', () => {
    fc.assert(
      fc.property(sectionedArbitrary, (all) => {
        expect(Sectioned.entries(all)).toEqual(all.sections.flatMap((section) => section.entries))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('Sectioned.map', () => {
  it('should give back the container itself when every entry comes back as itself', () => {
    expect(Sectioned.map(sectioned, (entry) => entry)).toBe(sectioned)
  })

  it('should replace only the entries that changed, keeping every untouched entry and section as itself', () => {
    const retitled = Sectioned.map(sectioned, (entry) =>
      entry.key === 'k-2' ? { ...entry, title: 'Patient C' } : entry
    )

    expect(retitled).not.toBe(sectioned)
    expect(retitled.sections[0]).toBe(sectioned.sections[0])
    expect(retitled.sections[1]?.entries[0]).toBe(sectioned.sections[1]?.entries[0])
    expect(retitled.sections[1]).toEqual({
      title: 'Second',
      entries: [
        { key: 'k-1', title: 'Patient/b' },
        { key: 'k-2', title: 'Patient C' },
      ],
    })
  })

  it('property: the mapped entries are the entries mapped, sections and titles kept', () => {
    fc.assert(
      fc.property(sectionedArbitrary, (all) => {
        const mapped = Sectioned.map(all, (entry) => entry.key)

        expect(Sectioned.entries(mapped)).toEqual(Sectioned.entries(all).map((entry) => entry.key))
        expect(mapped.sections.map((section) => section.title)).toEqual(
          all.sections.map((section) => section.title)
        )
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('Sectioned.filterMap', () => {
  it('should keep the values of the entries kept and drop a section left empty', () => {
    const kept = Sectioned.filterMap(sectioned, (entry) =>
      entry.key === 'k-0' ? Option.none() : Option.some(entry.key)
    )

    expect(kept).toEqual({ sections: [{ title: 'Second', entries: ['k-1', 'k-2'] }] })
  })
})

describe('Sectioned.filter', () => {
  it('should keep the entries the predicate holds for and drop a section left empty', () => {
    expect(Sectioned.filter(sectioned, (entry) => entry.key === 'k-2')).toEqual({
      sections: [{ title: 'Second', entries: [{ key: 'k-2', title: 'Patient/c' }] }],
    })
  })
})

describe('Sectioned.forEach', () => {
  it('should run the effect over every entry, keeping section and entry order', () => {
    const keys = Effect.runSync(Sectioned.forEach(sectioned, (entry) => Effect.succeed(entry.key)))

    expect(keys).toEqual({
      sections: [
        { title: 'First', entries: ['k-0'] },
        { title: 'Second', entries: ['k-1', 'k-2'] },
      ],
    })
  })
})

describe('Sectioned.groupBy', () => {
  it('should section entries by title in the order each title first appears', () => {
    const grouped = Sectioned.groupBy(
      [
        { url: 'b', key: 'k-0' },
        { url: '2', key: 'k-1' },
        { url: 'b', key: 'k-2' },
        { url: '1', key: 'k-3' },
      ],
      (entry) => entry.url
    )

    expect(
      grouped.sections.map(({ title, entries }) => [title, entries.map((entry) => entry.key)])
    ).toEqual([
      ['b', ['k-0', 'k-2']],
      ['2', ['k-1']],
      ['1', ['k-3']],
    ])
  })
})

describe('Sectioned.combine', () => {
  it('should keep both containers’ sections in order, never merging two that share a title', () => {
    const first = Sectioned.of('Same', ['a'])
    const second = Sectioned.of('Same', ['b'])

    expect(Sectioned.combine(first, second)).toEqual({
      sections: [
        { title: 'Same', entries: ['a'] },
        { title: 'Same', entries: ['b'] },
      ],
    })
    expect(Sectioned.combineAll([first, Sectioned.empty(), second])).toEqual(
      Sectioned.combine(first, second)
    )
  })

  it('should put a prepended section first and an appended one last', () => {
    const around = Sectioned.append(
      Sectioned.prepend(Sectioned.of('Middle', ['m']), { title: 'First', entries: ['f'] }),
      { title: 'Last', entries: ['l'] }
    )

    expect(around.sections.map((section) => section.title)).toEqual(['First', 'Middle', 'Last'])
  })
})
