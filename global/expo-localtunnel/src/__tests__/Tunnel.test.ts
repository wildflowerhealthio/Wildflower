/* oxlint-disable no-await-in-loop, typescript-eslint/no-unsafe-type-assertion, typescript-eslint/no-unsafe-assignment */
/**
 * Tests for `Tunnel._init` retry/cancellation behavior.
 *
 * The retry schedule is `RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000]`,
 * meaning the initial attempt is followed by up to five retries on failure.
 * After the sixth failure the open callback is invoked with an aggregate
 * Error that mentions the underlying cause and the attempt count.
 *
 * Calling `tunnel.close()` mid-retry must:
 *  - Abort any in-flight `fetch` (the `AbortController.signal` is passed to fetch).
 *  - Prevent further retries (no additional fetch calls).
 *  - Invoke the open callback exactly once with
 *    `Error('tunnel closed before connection established')`, so callers
 *    awaiting the Promise see a predictable rejection instead of hanging.
 *
 * `await` inside the step loops is intentional: each step depends on the
 * timers/microtasks of the previous step, so `Promise.all` would change the
 * meaning of the test. The eslint rule is disabled for this file only.
 */

import { fc, test as fcTest } from '@fast-check/jest'

import type TunnelType from '../Tunnel.ts'

const mockCreateTunnelConnection = jest.fn().mockResolvedValue(undefined)
const mockCloseTunnelConnection = jest.fn().mockResolvedValue(undefined)
const mockCloseAllTunnelConnections = jest.fn().mockResolvedValue(undefined)
const mockAddListener = jest.fn().mockReturnValue({ remove: jest.fn() })

jest.mock('../ExpoLocaltunnelModule', () => ({
  __esModule: true,
  default: {
    createTunnelConnection: mockCreateTunnelConnection,
    closeTunnelConnection: mockCloseTunnelConnection,
    closeAllTunnelConnections: mockCloseAllTunnelConnections,
    addListener: mockAddListener,
  },
}))

// `require` (not `import`) is load-bearing — see the analogous note in the
// sister package's tests. ES imports get hoisted above `jest.mock()`'s
// captured factory variables and would race; `require` runs in source order.
const Tunnel: typeof TunnelType = require('../Tunnel.ts').default

// The schedule lives only inside the implementation as a `const`. Re-declare
// it here so the tests assert against an explicit, reviewable contract — if
// the source schedule changes, this test file fails loudly.
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000] as const
const TOTAL_ATTEMPT_BUDGET = RETRY_DELAYS_MS.length + 1 // 6

interface AssignBody {
  id: string
  port: number
  url: string
  max_conn_count?: number
}

function okJsonResponse(body: AssignBody): {
  ok: true
  json: () => Promise<AssignBody>
  text: () => Promise<string>
} {
  return {
    ok: true,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  }
}

/** Drain any microtasks queued by the most recent `setTimeout` firing. */
async function flushMicrotasks(rounds: number = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve()
  }
}

/** Walk the retry schedule by `steps` ticks, draining microtasks around each timer advance. */
async function advanceRetrySteps(steps: number): Promise<void> {
  for (let i = 0; i < steps; i++) {
    await flushMicrotasks()
    jest.advanceTimersByTime(RETRY_DELAYS_MS[i] ?? 0)
    await flushMicrotasks()
  }
}

describe('Tunnel._init retry behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  test('a successful first fetch invokes the open callback with no error', async () => {
    const fetchFn = jest.fn().mockResolvedValueOnce(
      okJsonResponse({
        id: 'fast',
        port: 1,
        url: 'https://fast.localtunnel.me',
      })
    )
    globalThis.fetch = fetchFn as unknown as typeof fetch

    const tunnel = new Tunnel({ port: 8000 })
    const cb = jest.fn()
    tunnel.open(cb)

    await flushMicrotasks()

    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith()
    expect(tunnel.url).toBe('https://fast.localtunnel.me')
    expect(fetchFn).toHaveBeenCalledTimes(1)
    tunnel.close()
  })

  test('retries on transient failures with the documented backoff schedule', async () => {
    const fetchFn = jest.fn()
    // First five attempts fail, sixth succeeds.
    for (let i = 0; i < 5; i++) {
      fetchFn.mockRejectedValueOnce(new Error(`transient ${i}`))
    }
    fetchFn.mockResolvedValueOnce(
      okJsonResponse({
        id: 'eventually',
        port: 2,
        url: 'https://eventually.localtunnel.me',
      })
    )
    globalThis.fetch = fetchFn as unknown as typeof fetch

    const tunnel = new Tunnel({ port: 8000 })
    const cb = jest.fn()
    tunnel.open(cb)

    await advanceRetrySteps(RETRY_DELAYS_MS.length)

    expect(fetchFn).toHaveBeenCalledTimes(TOTAL_ATTEMPT_BUDGET)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith()
    expect(tunnel.url).toBe('https://eventually.localtunnel.me')
    tunnel.close()
  })

  test('after exhausting the retry budget, the callback receives an Error mentioning the underlying cause', async () => {
    const fetchFn = jest.fn()
    for (let i = 0; i < TOTAL_ATTEMPT_BUDGET; i++) {
      fetchFn.mockRejectedValueOnce(new Error(`boom-${i}`))
    }
    globalThis.fetch = fetchFn as unknown as typeof fetch

    const tunnel = new Tunnel({ port: 8000 })
    const cb = jest.fn()
    tunnel.open(cb)

    await advanceRetrySteps(RETRY_DELAYS_MS.length)
    // Final failure (the 6th attempt) does not schedule another wait.
    await flushMicrotasks()

    expect(fetchFn).toHaveBeenCalledTimes(TOTAL_ATTEMPT_BUDGET)
    expect(cb).toHaveBeenCalledTimes(1)
    const err = cb.mock.calls[0]?.[0] as Error
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toMatch(/failed to reach localtunnel server/i)
    expect(err.message).toMatch(new RegExp(`${TOTAL_ATTEMPT_BUDGET} attempts`))
    // The last underlying cause's message is preserved at the tail.
    expect(err.message).toContain(`boom-${TOTAL_ATTEMPT_BUDGET - 1}`)
    tunnel.close()
  })

  test('non-2xx response uses the response body text as the error message before retrying', async () => {
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        text: () => Promise.resolve('server is busy'),
        json: () => Promise.reject(new Error('not json')),
      })
      .mockResolvedValueOnce(
        okJsonResponse({ id: 'recovered', port: 3, url: 'https://recovered.localtunnel.me' })
      )
    globalThis.fetch = fetchFn as unknown as typeof fetch

    const tunnel = new Tunnel({ port: 8000 })
    const cb = jest.fn()
    tunnel.open(cb)

    // First attempt yields a non-OK response — the rejection path schedules
    // a 1s wait before retrying.
    await advanceRetrySteps(1)

    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith()
    tunnel.close()
  })

  test('invalid response body shape is treated as a retryable failure', async () => {
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve('{}'),
        json: () => Promise.resolve({ not: 'an assign body' }),
      })
      .mockResolvedValueOnce(
        okJsonResponse({ id: 'good', port: 4, url: 'https://good.localtunnel.me' })
      )
    globalThis.fetch = fetchFn as unknown as typeof fetch

    const tunnel = new Tunnel({ port: 8000 })
    const cb = jest.fn()
    tunnel.open(cb)

    await advanceRetrySteps(1)

    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(cb).toHaveBeenCalledWith()
    tunnel.close()
  })
})

describe('Tunnel._init cancellation via close()', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  test('close() before the first response cancels the in-flight request via the AbortSignal', async () => {
    const seenSignals: AbortSignal[] = []
    let neverResolve: ((value: never) => void) | undefined

    const fetchFn = jest
      .fn()
      .mockImplementation((_uri: string, init?: { signal?: AbortSignal }) => {
        if (init?.signal) seenSignals.push(init.signal)
        return new Promise<never>((_resolve, reject) => {
          // Mimic real fetch: reject when the signal aborts.
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          })
          neverResolve = _resolve
        })
      })
    globalThis.fetch = fetchFn as unknown as typeof fetch

    const tunnel = new Tunnel({ port: 8000 })
    const cb = jest.fn()
    tunnel.open(cb)

    await flushMicrotasks()
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(seenSignals[0]?.aborted).toBe(false)

    tunnel.close()

    expect(seenSignals[0]?.aborted).toBe(true)
    // close() rejects the open callback synchronously via the abort listener.
    await flushMicrotasks()
    expect(cb).toHaveBeenCalledTimes(1)
    const err = cb.mock.calls[0]?.[0] as Error
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toMatch(/closed before connection established/i)

    // Sanity: keep the lint-checker happy that we held the resolve handle.
    expect(typeof neverResolve).toBe('function')
  })

  test('close() during a backoff wait cancels the next attempt', async () => {
    const fetchFn = jest.fn().mockRejectedValue(new Error('always-fails'))
    globalThis.fetch = fetchFn as unknown as typeof fetch

    const tunnel = new Tunnel({ port: 8000 })
    const cb = jest.fn()
    tunnel.open(cb)

    // First attempt fails — a 1s wait is scheduled.
    await flushMicrotasks()
    expect(fetchFn).toHaveBeenCalledTimes(1)

    // Advance halfway into the backoff and close; the timer should fire its
    // abort branch and the next attempt should not be made.
    jest.advanceTimersByTime(500)
    tunnel.close()
    jest.advanceTimersByTime(10_000)
    await flushMicrotasks()

    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledTimes(1)
    const err = cb.mock.calls[0]?.[0] as Error
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toMatch(/closed before connection established/i)
  })

  test('the AbortController signal is forwarded to fetch on every attempt', async () => {
    const seenSignals: AbortSignal[] = []
    const fetchFn = jest
      .fn()
      .mockImplementation((_uri: string, init?: { signal?: AbortSignal }) => {
        if (init?.signal) seenSignals.push(init.signal)
        return Promise.reject(new Error('still failing'))
      })
    globalThis.fetch = fetchFn as unknown as typeof fetch

    const tunnel = new Tunnel({ port: 8000 })
    tunnel.open(jest.fn())

    // Drive two attempts.
    await advanceRetrySteps(1)

    expect(seenSignals.length).toBe(2)
    // All attempts share the same controller — same signal reference.
    expect(seenSignals[0]).toBe(seenSignals[1])
    tunnel.close()
    expect(seenSignals[0]?.aborted).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Property test: the exhausted-budget error message is shaped consistently
// across underlying cause messages. This catches regressions in the templated
// string format.
// ---------------------------------------------------------------------------

describe('Tunnel._init exhausted-budget error format (property)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  fcTest.prop({
    causeMessage: fc.string({ minLength: 1, maxLength: 32 }).filter((s) => !s.includes('\n')),
  })(
    'final error message includes attempt count and the last underlying cause message',
    async ({ causeMessage }) => {
      const fetchFn = jest.fn()
      for (let i = 0; i < TOTAL_ATTEMPT_BUDGET - 1; i++) {
        fetchFn.mockRejectedValueOnce(new Error(`other-${i}`))
      }
      fetchFn.mockRejectedValueOnce(new Error(causeMessage))
      globalThis.fetch = fetchFn as unknown as typeof fetch

      const tunnel = new Tunnel({ port: 8000 })
      const cb = jest.fn()
      tunnel.open(cb)

      await advanceRetrySteps(RETRY_DELAYS_MS.length)
      await flushMicrotasks()

      expect(cb).toHaveBeenCalledTimes(1)
      const err = cb.mock.calls[0]?.[0] as Error
      expect(err.message).toContain(`${TOTAL_ATTEMPT_BUDGET} attempts`)
      expect(err.message).toContain(causeMessage)
      tunnel.close()
    }
  )
})
