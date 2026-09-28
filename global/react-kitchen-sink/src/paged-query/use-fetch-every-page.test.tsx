import { type RenderHookResult, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vite-plus/test'

import type { PagedQuery } from './paged-query.ts'
import { type FetchEveryPageOptions, useFetchEveryPage } from './use-fetch-every-page.ts'

/** What each render hands the hook: the read as it stands, and the options. */
interface DrainProps {
  readonly pagedQuery: PagedQuery<number>
  readonly options?: FetchEveryPageOptions
}

/** A read with `pagesLanded` pages and a next page reported, over `fetchNextPage`. */
const pagedQueryAt = (
  pagesLanded: number,
  fetchNextPage: () => Promise<unknown>,
  overrides: Partial<PagedQuery<number>> = {}
): PagedQuery<number> => ({
  data: pagesLanded === 0 ? undefined : { pages: Array.from({ length: pagesLanded }, (_, i) => i) },
  error: null,
  isError: false,
  hasNextPage: true,
  isFetchingNextPage: false,
  isFetchNextPageError: false,
  fetchNextPage,
  ...overrides,
})

const renderDrain = (initialProps: DrainProps): RenderHookResult<void, DrainProps> =>
  renderHook(
    ({ pagedQuery, options }: DrainProps) => {
      useFetchEveryPage(pagedQuery, options)
    },
    { initialProps }
  )

describe('useFetchEveryPage', () => {
  it('leaves the first page to the query itself', () => {
    const fetchNextPage = vi.fn(() => Promise.resolve(undefined))

    renderDrain({ pagedQuery: pagedQueryAt(0, fetchNextPage) })

    expect(fetchNextPage).not.toHaveBeenCalled()
  })

  it('asks for the next page once a page has landed and another is reported', () => {
    const fetchNextPage = vi.fn(() => Promise.resolve(undefined))

    renderDrain({ pagedQuery: pagedQueryAt(1, fetchNextPage) })

    expect(fetchNextPage).toHaveBeenCalledTimes(1)
  })

  it('asks again for each page that lands, even when none showed as in flight', () => {
    // Arrange
    const fetchNextPage = vi.fn(() => Promise.resolve(undefined))
    const { rerender } = renderDrain({ pagedQuery: pagedQueryAt(1, fetchNextPage) })

    // Act — page two lands within one commit: only the page count changed
    rerender({ pagedQuery: pagedQueryAt(2, fetchNextPage) })

    // Assert
    expect(fetchNextPage).toHaveBeenCalledTimes(2)
  })

  it('does not ask while a page is in flight', () => {
    const fetchNextPage = vi.fn(() => Promise.resolve(undefined))

    renderDrain({
      pagedQuery: pagedQueryAt(1, fetchNextPage, { isFetchingNextPage: true }),
    })

    expect(fetchNextPage).not.toHaveBeenCalled()
  })

  it('stops once the last page has landed', () => {
    const fetchNextPage = vi.fn(() => Promise.resolve(undefined))

    renderDrain({ pagedQuery: pagedQueryAt(3, fetchNextPage, { hasNextPage: false }) })

    expect(fetchNextPage).not.toHaveBeenCalled()
  })

  it('halts on a failed page rather than asking for it again', () => {
    // Arrange
    const fetchNextPage = vi.fn(() => Promise.resolve(undefined))
    const failed = pagedQueryAt(1, fetchNextPage, { isError: true, isFetchNextPageError: true })
    const { rerender } = renderDrain({ pagedQuery: failed })

    // Act — a later render with nothing changed
    rerender({ pagedQuery: { ...failed } })

    // Assert
    expect(fetchNextPage).not.toHaveBeenCalled()
  })

  it('holds while disabled and resumes when enabled', () => {
    // Arrange
    const fetchNextPage = vi.fn(() => Promise.resolve(undefined))
    const pagedQuery = pagedQueryAt(1, fetchNextPage)
    const { rerender } = renderDrain({ pagedQuery, options: { enabled: false } })
    expect(fetchNextPage).not.toHaveBeenCalled()

    // Act
    rerender({ pagedQuery, options: { enabled: true } })

    // Assert
    expect(fetchNextPage).toHaveBeenCalledTimes(1)
  })
})
