import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Effect, Either, Option } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { nextPageToken, type PageLink, type SearchsetPage, searchAllPages } from './search-pages.ts'

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

describe('searchAllPages', () => {
  it('should read every page the next links chain to, in order', async () => {
    // Arrange
    const asked: Option.Option<string>[] = []
    const pages = new Map<string | null, SearchsetPage<string>>([
      [null, page(['a', 'b'], 'p-2')],
      ['p-2', page(['c'], 'p-3')],
      ['p-3', page(['d'], undefined)],
    ])

    // Act
    const resources = await Effect.runPromise(
      searchAllPages(
        (pageToken) => {
          asked.push(pageToken)
          return Effect.succeed(pages.get(Option.getOrNull(pageToken)) ?? page([], undefined))
        },
        { pageLimit: 10 }
      )
    )

    // Assert
    expect(resources).toEqual(['a', 'b', 'c', 'd'])
    expect(asked).toEqual([Option.none(), Option.some('p-2'), Option.some('p-3')])
  })

  it('should stop at the page limit and give what it has', async () => {
    const resources = await Effect.runPromise(
      searchAllPages(
        (pageToken) => Effect.succeed(page([Option.getOrElse(pageToken, () => 'first')], 'again')),
        {
          pageLimit: 3,
        }
      )
    )

    expect(resources).toEqual(['first', 'again', 'again'])
  })

  it('should fail the read when a page fails, rather than giving the pages before it', async () => {
    const outcome = await Effect.runPromise(
      Effect.either(
        searchAllPages(
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

  it('should always give exactly the non-null resources of the pages read, however many there are', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.array(fc.option(fc.string(), { nil: null }))),
        fc.integer({ min: 1, max: 20 }),
        async (entries, pageLimit) => {
          // Arrange: page n continues to page n+1 until the last
          const pagesRead = entries.slice(0, pageLimit)

          // Act
          const resources = await Effect.runPromise(
            searchAllPages(
              (pageToken) => {
                const index = Option.match(pageToken, { onNone: () => 0, onSome: Number })
                const next = index + 1 < entries.length ? String(index + 1) : undefined
                return Effect.succeed({
                  entry: (entries[index] ?? []).map((resource) => ({ resource })),
                  link: next === undefined ? [] : [nextLink(`/X?_pageToken=${next}`)],
                })
              },
              { pageLimit }
            )
          )

          // Assert
          expect(resources).toEqual(pagesRead.flat().filter((resource) => resource !== null))
        }
      ),
      { numRuns: RUNS }
    )
  })
})

// Helpers

const nextLink = (url: string): PageLink => ({ relation: 'next', url })

const page = (resources: readonly string[], next: string | undefined): SearchsetPage<string> => ({
  entry: resources.map((resource) => ({ resource })),
  link: next === undefined ? [] : [nextLink(`/Patient?_count=2&_pageToken=${next}`)],
})
