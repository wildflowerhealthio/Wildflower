import { describe, expect, it } from 'vite-plus/test'

import { type PagedQuery, pagedQueryStatusOf } from './paged-query.ts'

/** A paged read with one page landed and nothing more reported, overridden by `overrides`. */
const pagedQueryWith = (overrides: Partial<PagedQuery<string>>): PagedQuery<string> => ({
  data: { pages: ['page one'] },
  error: null,
  isError: false,
  hasNextPage: false,
  isFetchingNextPage: false,
  isFetchNextPageError: false,
  fetchNextPage: () => Promise.resolve(undefined),
  ...overrides,
})

const failure = new Error('page failed')

describe('pagedQueryStatusOf', () => {
  it('is loading before any page has landed or failed', () => {
    expect(pagedQueryStatusOf(pagedQueryWith({ data: undefined }))).toEqual({ kind: 'loading' })
  })

  it('is failed, carrying the error, when the first page failed', () => {
    const status = pagedQueryStatusOf(
      pagedQueryWith({ data: undefined, isError: true, error: failure })
    )
    expect(status).toEqual({ kind: 'failed', error: failure })
  })

  it('is paging while the server reports a next page, saying whether it is in flight', () => {
    expect(pagedQueryStatusOf(pagedQueryWith({ hasNextPage: true }))).toEqual({
      kind: 'paging',
      isFetchingNextPage: false,
    })
    expect(
      pagedQueryStatusOf(pagedQueryWith({ hasNextPage: true, isFetchingNextPage: true }))
    ).toEqual({ kind: 'paging', isFetchingNextPage: true })
  })

  it('is page-failed, carrying the error, when a later page failed', () => {
    const status = pagedQueryStatusOf(
      pagedQueryWith({
        hasNextPage: true,
        isError: true,
        isFetchNextPageError: true,
        error: failure,
      })
    )
    expect(status).toEqual({ kind: 'page-failed', error: failure })
  })

  it('is complete once pages have landed and no next page is reported', () => {
    expect(pagedQueryStatusOf(pagedQueryWith({}))).toEqual({ kind: 'complete' })
  })
})
