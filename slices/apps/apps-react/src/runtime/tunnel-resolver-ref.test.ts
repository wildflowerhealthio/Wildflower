import fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { afterEach, describe, expect, test } from 'vite-plus/test'

import {
  clearPendingTunnelResolverIfCurrent,
  makeAppsWebHandlers,
  setPendingTunnelResolver,
  type TunnelOutcome,
} from './tunnel-resolver-ref.ts'

/**
 * Pins the singleton resolver-ref's supersede semantics: an overlapping
 * `useRequestTunnel()` (e.g. a double-click) must settle the prior
 * Promise rather than dangle it. Without the supersede the predecessor's
 * `settled`/`timer` closure would lose the resolver-ref slot while its
 * own 8s timer was still pending, leaving the caller hanging until the
 * timer fired — and a host response that arrived in the meantime would
 * land on the new request (the only one still reachable through the ref).
 *
 * `makeAppsWebHandlers` is exported so a future test can drive the
 * receiver-side path; for the supersede invariant the resolver-ref API
 * is sufficient.
 */

// The resolver-ref is module-scoped; reset between tests so a leftover
// installation from one case doesn't supersede the next case's first
// install (which would record an unexpected outcome).
afterEach(() => {
  setPendingTunnelResolver(null)
})

describe('setPendingTunnelResolver', () => {
  test('exists as an exported function and is callable with null / a resolver', () => {
    expect(() => setPendingTunnelResolver(null)).not.toThrow()
    expect(() => setPendingTunnelResolver(() => undefined)).not.toThrow()
  })

  test('installing a second resolver settles the first with a "superseded" error', () => {
    const outcomes: Array<TunnelOutcome> = []
    const firstResolver = (outcome: TunnelOutcome): void => {
      outcomes.push(outcome)
    }
    const secondResolver = (outcome: TunnelOutcome): void => {
      outcomes.push(outcome)
    }

    setPendingTunnelResolver(firstResolver)
    setPendingTunnelResolver(secondResolver)

    // The predecessor — and only the predecessor — has been settled.
    expect(outcomes).toEqual([{ error: 'superseded by newer request' }])
  })

  test('clearing with null does NOT settle the installed resolver (callers settle on their own path)', () => {
    const outcomes: Array<TunnelOutcome> = []
    setPendingTunnelResolver((outcome) => outcomes.push(outcome))

    setPendingTunnelResolver(null)

    // null-cleared installations are the resolver's own settle-on-success
    // / settle-on-timeout cleanup re-entering this function; settling
    // them again would double-resolve the Promise.
    expect(outcomes).toEqual([])
  })

  test('N overlapping installs settle all but the most recent with the supersede error (property)', () => {
    // Drives the supersede invariant across the input space: for any
    // sequence of N ≥ 2 overlapping `setPendingTunnelResolver` calls
    // (each modelling a fresh `useRequestTunnel()` invocation that
    // hasn't yet received a host response), every Promise except the
    // last must settle with the supersede error. Without the fix the
    // prior N − 1 Promises would dangle until their individual 8s
    // timers fired.
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 32 }), (n) => {
        const settledBy: Array<number> = []
        for (let id = 0; id < n; id++) {
          const captured = id
          setPendingTunnelResolver((outcome): void => {
            if ('error' in outcome && outcome.error === 'superseded by newer request') {
              settledBy.push(captured)
            }
          })
        }
        // Every install except the final one has been superseded.
        expect(settledBy).toEqual(Array.from({ length: n - 1 }, (_, i) => i))
        // The final resolver is still installed; clear it cleanly so
        // the next property iteration starts from a known state.
        setPendingTunnelResolver(null)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('clearPendingTunnelResolverIfCurrent', () => {
  test('clears the ref when the supplied resolver matches', () => {
    const outcomes: Array<TunnelOutcome> = []
    const resolver = (outcome: TunnelOutcome): void => {
      outcomes.push(outcome)
    }
    setPendingTunnelResolver(resolver)
    clearPendingTunnelResolverIfCurrent(resolver)
    // No supersede on a fresh install after the clear — confirms the
    // ref is back to null. (If clear had been a no-op, the new install
    // would have supersede-settled the previous resolver.)
    const next = (outcome: TunnelOutcome): void => {
      outcomes.push(outcome)
    }
    setPendingTunnelResolver(next)
    expect(outcomes).toEqual([])
  })

  test('is a no-op when a successor has taken the slot (set-if-equal)', () => {
    // Tag each settled outcome with its source resolver via a parallel
    // tuple — `TunnelOutcome` is a closed `{origin} | {error}` union,
    // so the source identity lives outside the outcome shape.
    const settled: Array<{ readonly via: string; readonly outcome: TunnelOutcome }> = []
    const first = (outcome: TunnelOutcome): void => {
      settled.push({ via: 'first', outcome })
    }
    const second = (outcome: TunnelOutcome): void => {
      settled.push({ via: 'second', outcome })
    }
    setPendingTunnelResolver(first)
    setPendingTunnelResolver(second)
    // `first` got superseded in the second install (settled with an
    // error). A stale `first`-clearing path firing here must NOT
    // blank `second`, so a subsequent host response still reaches it.
    clearPendingTunnelResolverIfCurrent(first)

    // Drive a manual settle of `second` by superseding it once more.
    const third = (outcome: TunnelOutcome): void => {
      settled.push({ via: 'third', outcome })
    }
    setPendingTunnelResolver(third)

    // Outcomes: first superseded by second; second superseded by third.
    // If `clearPendingTunnelResolverIfCurrent(first)` had blanked the
    // ref, the third install would have seen previous=null and no
    // second-supersede outcome would have been recorded.
    expect(settled).toEqual([
      { via: 'first', outcome: { error: 'superseded by newer request' } },
      { via: 'second', outcome: { error: 'superseded by newer request' } },
    ])
  })
})

describe('makeAppsWebHandlers', () => {
  test('builds a handler record with TunnelStarted / TunnelFailed handlers', () => {
    // The handlers' interaction with the resolver-ref is exercised
    // end-to-end via the apps-react route tests; this assertion just
    // pins that the factory returns a record keyed by the AppsBridge
    // Host→Web tags, so a refactor that drops or renames a handler
    // surfaces here before reaching the transport build.
    const handlers = makeAppsWebHandlers()
    expect(typeof handlers.TunnelStarted).toBe('function')
    expect(typeof handlers.TunnelFailed).toBe('function')
  })
})
