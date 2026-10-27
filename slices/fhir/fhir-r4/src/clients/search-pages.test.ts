import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Effect, Either, Option } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import {
  matchesIn,
  nextPageToken,
  type PageLink,
  type SearchsetEntry,
  type SearchsetPage,
  searchAllPages,
} from './search-pages.ts'

const RUNS = numRunsFor({ base: 100 })

describe('nextPageToken', () => {
  it('should read the _pageToken off the next link, relative or absolute', () => {
    expect(nextPageToken([nextLink('/Patient?_count=50&_pageToken=cursor-2')])).toBe('cursor-2')
    expect(
      nextPageToken([nextLink('https://fhir.example/Patient?_count=50&_pageToken=cursor-2')])
    ).toBe('cursor-2')
  })

  it('should read no token when there is no next link, or it carries none', () => {
    expect(nextPageToken([])).toBeUndefined()
    expect(nextPageToken([{ relation: 'self', url: '/Patient?_pageToken=x' }])).toBeUndefined()
    expect(nextPageToken([nextLink('/Patient?_count=50')])).toBeUndefined()
    expect(nextPageToken([nextLink('/Patient?_pageToken=')])).toBeUndefined()
  })
})

describe('matchesIn', () => {
  it('should give every match its resource, and pass over an outcome entry', async () => {
    const matches = await Effect.runPromise(
      matchesIn('Patient', {
        entry: [match('a'), { resource: null, search: { mode: 'outcome' } }, match('b')],
      })
    )

    expect(matches).toEqual(['a', 'b'])
  })

  it('should fail on a match that carries no resource, naming the type searched', async () => {
    const outcome = await Effect.runPromise(
      Effect.either(
        matchesIn('Practitioner', { entry: [match('a'), { resource: null, search: null }] })
      )
    )

    expect(outcome).toMatchObject({
      _tag: 'Left',
      left: { _tag: 'MatchWithoutResource', resourceType: 'Practitioner' },
    })
  })
})

describe('searchAllPages', () => {
  it('should read every page the next links chain to, in order, and say the list is whole', async () => {
    // Arrange
    const asked: Option.Option<string>[] = []
    const pages = new Map<string | null, SearchsetPage<string>>([
      [null, page(['a', 'b'], 'p-2')],
      ['p-2', page(['c'], 'p-3')],
      ['p-3', page(['d'], undefined)],
    ])

    // Act
    const read = await Effect.runPromise(
      searchAllPages(
        'Patient',
        (pageToken) => {
          asked.push(pageToken)
          return Effect.succeed(pages.get(Option.getOrNull(pageToken)) ?? page([], undefined))
        },
        { pageLimit: 10 }
      )
    )

    // Assert
    expect(read).toEqual({ matches: ['a', 'b', 'c', 'd'], truncated: false })
    expect(asked).toEqual([Option.none(), Option.some('p-2'), Option.some('p-3')])
  })

  it('should stop at the page limit, give what it has, and say pages were left unread', async () => {
    const read = await Effect.runPromise(
      searchAllPages(
        'Patient',
        (pageToken) =>
          Effect.succeed(
            page(
              [Option.getOrElse(pageToken, () => 'first')],
              `after-${Option.getOrElse(pageToken, () => 'first')}`
            )
          ),
        { pageLimit: 3 }
      )
    )

    expect(read).toEqual({
      matches: ['first', 'after-first', 'after-after-first'],
      truncated: true,
    })
  })

  it('should not call a list truncated when the last page the limit allows is the last page', async () => {
    const read = await Effect.runPromise(
      searchAllPages(
        'Patient',
        (pageToken) =>
          Effect.succeed(Option.isNone(pageToken) ? page(['a'], 'p-2') : page(['b'], undefined)),
        { pageLimit: 2 }
      )
    )

    expect(read).toEqual({ matches: ['a', 'b'], truncated: false })
  })

  it('should fail the read when a page fails, rather than giving the pages before it', async () => {
    const outcome = await Effect.runPromise(
      Effect.either(
        searchAllPages(
          'Patient',
          (pageToken) =>
            Option.isNone(pageToken)
              ? Effect.succeed(page(['a'], 'p-2'))
              : Effect.fail(new Error('503')),
          { pageLimit: 10 }
        )
      )
    )

    expect(Either.isLeft(outcome)).toBe(true)
  })

  it('should fail the read when a next link names a page already read, rather than reading it again', async () => {
    const outcome = await Effect.runPromise(
      Effect.either(
        searchAllPages(
          'Patient',
          (pageToken) =>
            Effect.succeed(Option.isNone(pageToken) ? page(['a'], 'p-2') : page(['b'], 'p-2')),
          { pageLimit: 10 }
        )
      )
    )

    expect(outcome).toMatchObject({
      _tag: 'Left',
      left: { _tag: 'PageTokenRepeated', pageToken: 'p-2' },
    })
  })

  it('should always give exactly the matches of the pages read, however many there are', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.array(fc.string())),
        fc.integer({ min: 1, max: 20 }),
        async (entries, pageLimit) => {
          // Arrange: page n continues to page n+1 until the last
          const pagesRead = entries.slice(0, pageLimit)

          // Act
          const read = await Effect.runPromise(
            searchAllPages(
              'Patient',
              (pageToken) => {
                const index = Option.match(pageToken, { onNone: () => 0, onSome: Number })
                const next = index + 1 < entries.length ? String(index + 1) : undefined
                return Effect.succeed({
                  entry: (entries[index] ?? []).map(match),
                  link: next === undefined ? [] : [nextLink(`/X?_pageToken=${next}`)],
                })
              },
              { pageLimit }
            )
          )

          // Assert
          expect(read).toEqual({
            matches: pagesRead.flat(),
            truncated: entries.length > pageLimit,
          })
        }
      ),
      { numRuns: RUNS }
    )
  })
})

// Helpers

const nextLink = (url: string): PageLink => ({ relation: 'next', url })

const match = (resource: string): SearchsetEntry<string> => ({
  resource,
  search: { mode: 'match' },
})

const page = (resources: readonly string[], next: string | undefined): SearchsetPage<string> => ({
  entry: resources.map(match),
  link: next === undefined ? [] : [nextLink(`/Patient?_count=2&_pageToken=${next}`)],
})
