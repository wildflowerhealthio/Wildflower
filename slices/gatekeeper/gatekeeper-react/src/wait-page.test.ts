// This test reads the page's files and the palette off disk, so it opts in to
// Node's types for itself alone (as `react-tundraish`'s `colors-custom.test.ts`
// does). Off disk rather than `?raw`: under Vitest a CSS `?raw` import is an
// empty string.
/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

// The gatekeeper's `/oauth/authorize/{id}/wait` page is plain HTML, CSS and JS
// embedded in `gatekeeper-rust` (`http/routes/oauth/wait_page.rs`). The Rust
// side pins how it is served; this pins what the script does, and holds the
// stylesheet's copied colours to the palette. It lives here because this
// package can read react-tundraish.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const WAIT_PAGE_DIR = join(
  REPO_ROOT,
  'slices/gatekeeper/gatekeeper-rust/src/http/routes/oauth/wait_page'
)
const waitPageHtml = readFileSync(join(WAIT_PAGE_DIR, 'wait.html'), 'utf8')
const waitPageScript = readFileSync(join(WAIT_PAGE_DIR, 'wait.js'), 'utf8')
const waitPageStylesheet = readFileSync(join(WAIT_PAGE_DIR, 'wait.css'), 'utf8')
const palette = readFileSync(
  join(REPO_ROOT, 'global/react-tundraish/src/colors-custom.css'),
  'utf8'
)

const WAIT_PATH = '/oauth/authorize/req-1/wait'
const STATUS_PATH = '/oauth/authorize/req-1'
const CALLBACK = 'https://app.example/cb?code=the-code&state=xyz'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('wait page script', () => {
  it('should poll the sibling status endpoint until approved, then leave for the callback', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 4 }), async (pendingPolls) => {
        // Arrange
        const statuses = [
          ...Array.from({ length: pendingPolls }, () => json({ status: 'pending' })),
          json({ status: 'approved', redirect: CALLBACK }),
        ]
        const page = openWaitPage(WAIT_PATH, answering(statuses))

        // Act
        await page.settle(pendingPolls + 1)

        // Assert
        expect(page.requested).toEqual(Array.from({ length: pendingPolls + 1 }, () => STATUS_PATH))
        expect(page.leftFor()).toBe(CALLBACK)
      }),
      { numRuns: numRunsFor({ base: 20 }) }
    )
  })

  it('should keep a percent-encoded request id as one segment of the status path', async () => {
    // Arrange
    const page = openWaitPage(
      '/oauth/authorize/a%2Fb/wait',
      answering([json({ status: 'approved', redirect: CALLBACK })])
    )

    // Act
    await page.settle(1)

    // Assert
    expect(page.requested).toEqual(['/oauth/authorize/a%2Fb'])
  })

  it('should carry a code-flow denial back to the client', async () => {
    // Arrange — the status carries the client's `error=access_denied` callback.
    const denial = 'https://app.example/cb?error=access_denied&state=xyz'
    const page = openWaitPage(WAIT_PATH, answering([json({ status: 'denied', redirect: denial })]))

    // Act
    await page.settle(1)

    // Assert
    expect(page.leftFor()).toBe(denial)
  })

  it('should show a denial with no client callback as declined', async () => {
    // Arrange
    const page = openWaitPage(WAIT_PATH, answering([json({ status: 'denied' })]))

    // Act
    await page.settle(1)

    // Assert
    expect(page.shown()).toEqual({
      state: 'denied',
      heading: 'Request declined',
      detail: 'The authorization request was declined.',
    })
    expect(page.leftFor()).toBeUndefined()
  })

  it('should show the message an error status carries', async () => {
    // Arrange
    const page = openWaitPage(
      WAIT_PATH,
      answering([json({ status: 'error', message: 'Authorization request expired' })])
    )

    // Act
    await page.settle(1)

    // Assert
    expect(page.shown()).toEqual({
      state: 'error',
      heading: 'Authorization error',
      detail: 'Authorization request expired',
    })
  })

  it('should stop with an error on a status response it cannot use', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Factories: a `Response` body can be read only once, and a property
        // reuses its generated values.
        fc.constantFrom(
          () =>
            new Response(JSON.stringify({ error: 'AuthorizationRequestNotFound' }), {
              status: 404,
            }),
          () => new Response(JSON.stringify({ error: 'server_error' }), { status: 500 }),
          () => new Response('not json', { status: 200 }),
          () => json({ status: 'something-new' })
        ),
        async (makeResponse) => {
          // Arrange
          const page = openWaitPage(WAIT_PATH, answering([makeResponse()]))

          // Act
          await page.settle(1)

          // Assert — one poll, then an error and no navigation.
          await vi.advanceTimersByTimeAsync(10_000)
          expect(page.requested).toHaveLength(1)
          expect(page.shown().state).toBe('error')
          expect(page.leftFor()).toBeUndefined()
        }
      ),
      { numRuns: numRunsFor({ base: 20 }) }
    )
  })

  it('should never leave for a redirect that is not http or https', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('javascript:alert(1)', 'data:text/html,hi', 'ftp://app.example/cb', 'cb'),
        fc.constantFrom('approved', 'denied'),
        async (redirect, status) => {
          // Arrange
          const page = openWaitPage(WAIT_PATH, answering([json({ status, redirect })]))

          // Act
          await page.settle(1)

          // Assert
          expect(page.leftFor()).toBeUndefined()
          expect(page.shown().state).toBe('error')
        }
      ),
      { numRuns: numRunsFor({ base: 20 }) }
    )
  })

  it('should ride out a few unreachable polls and still complete', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 4 }), async (unreachablePolls) => {
        // Arrange
        const page = openWaitPage(
          WAIT_PATH,
          answering([
            ...Array.from({ length: unreachablePolls }, () => unreachable),
            json({ status: 'approved', redirect: CALLBACK }),
          ])
        )

        // Act
        await page.settle(unreachablePolls + 1)

        // Assert
        expect(page.leftFor()).toBe(CALLBACK)
      }),
      { numRuns: numRunsFor({ base: 10 }) }
    )
  })

  it('should give up after five unreachable polls in a row', async () => {
    // Arrange
    const page = openWaitPage(WAIT_PATH, () => Promise.reject(new TypeError('Failed to fetch')))

    // Act
    await page.settle(5)
    await vi.advanceTimersByTimeAsync(10_000)

    // Assert
    expect(page.requested).toHaveLength(5)
    expect(page.shown()).toEqual({
      state: 'error',
      heading: 'Authorization error',
      detail: 'Could not reach the authorization server.',
    })
  })

  it('should not poll at all from an address that is not a wait page', async () => {
    // Arrange
    const page = openWaitPage('/oauth/authorize/req-1', answering([]))

    // Act
    await page.settle(0)

    // Assert
    expect(page.requested).toEqual([])
    expect(page.shown().state).toBe('error')
  })
})

describe('wait page stylesheet', () => {
  it('should paint the same light and dark colours the palette defines under each name', () => {
    // Every colour the page paints is a copy of a palette token under the same
    // name, one light and one dark value each. Both sides are read from their
    // sources, so a moved token or a stale copy fails here.
    const copied = tokenPairs(waitPageStylesheet)
    expect(copied.size).toBeGreaterThan(0)
    for (const [name, lightAndDark] of copied) {
      expect(tokenPairs(palette).get(name), name).toEqual(lightAndDark)
    }
  })
})

// Helpers

/** A JSON `200` response carrying `body`. */
const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

/** A poll that never reached the server. */
const unreachable = 'unreachable' as const

/** A `fetch` answering each poll with the next of `answers`, then failing the test. */
const answering = (answers: readonly (Response | typeof unreachable)[]): typeof fetch => {
  let polls = 0
  return () => {
    const answer = answers[polls]
    polls += 1
    if (answer === undefined) throw new Error('the page polled more times than the test answers')
    return answer === unreachable
      ? Promise.reject(new TypeError('Failed to fetch'))
      : Promise.resolve(answer)
  }
}

/** What the page is showing. */
interface Shown {
  readonly state: string | undefined
  readonly heading: string | null | undefined
  readonly detail: string | null | undefined
}

/**
 * Run the wait page's own script as a browser at `pathname` would, against a
 * parsed copy of its own HTML. `settle(polls)` advances the fake clock through
 * that many poll intervals.
 */
const openWaitPage = (
  pathname: string,
  fetchStub: typeof fetch
): {
  readonly requested: readonly string[]
  readonly settle: (polls: number) => Promise<void>
  readonly leftFor: () => string | undefined
  readonly shown: () => Shown
} => {
  const document = new DOMParser().parseFromString(waitPageHtml, 'text/html')
  const requested: string[] = []
  let leftFor: string | undefined
  const window = {
    location: {
      pathname,
      replace: (to: string) => {
        leftFor = to
      },
    },
  }
  const recordingFetch: typeof fetch = (input, init) => {
    // The page passes a root-relative path string.
    requested.push(typeof input === 'string' ? input : `unexpected ${typeof input}`)
    return fetchStub(input, init)
  }
  // oxlint-disable-next-line typescript/no-implied-eval -- runs the checked-in page's own script under test
  new Function('window', 'document', 'fetch', waitPageScript)(window, document, recordingFetch)
  return {
    requested,
    settle: async (polls) => {
      await vi.advanceTimersByTimeAsync(0)
      for (let poll = 1; poll < polls; poll++) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- each poll must settle before the clock moves to the next
        await vi.advanceTimersByTimeAsync(1500)
      }
    },
    leftFor: () => leftFor,
    shown: () => ({
      state: document.documentElement.dataset['state'],
      heading: document.getElementById('heading')?.textContent,
      detail: document.getElementById('detail')?.textContent,
    }),
  }
}

/** Each `--color-*: #hex` name in `css`, with its values in source order. */
const tokenPairs = (css: string): ReadonlyMap<string, readonly string[]> => {
  const pairs = new Map<string, string[]>()
  for (const [, name = '', value = ''] of css.matchAll(
    /(--color-[a-z0-9-]+):\s*(#[0-9a-f]{3,8})/gi
  )) {
    pairs.set(name, [...(pairs.get(name) ?? []), value.toLowerCase()])
  }
  return pairs
}
