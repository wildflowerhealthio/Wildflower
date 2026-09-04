import { useSyncExternalStore } from 'react'

// A store that never notifies: "now" is sampled on renders the caller already
// commits for other reasons, without any clock tick driving a re-render of its
// own. The freshness this yields matches that render cadence.
const noopSubscribe = (): (() => void) => (): void => {}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/**
 * A **quantized "now"** in epoch milliseconds, floored to the start of each
 * `quantumMs` window and read through `useSyncExternalStore` so the component's
 * render stays pure (no bare `Date.now()` at render time).
 *
 * Quantizing is what keeps the snapshot *cached* in React's sense: every call
 * within one window returns the identical number, so React's commit-phase
 * consistency re-check sees no change between the render sample and the commit
 * sample. An un-quantized `Date.now()` fails that check whenever a millisecond
 * boundary falls between the two — forcing a synchronous re-render (a potential
 * live-lock on a slow device) and, in dev, the "getSnapshot should be cached"
 * warning. Pick the coarsest `quantumMs` the caller's granularity allows.
 *
 * @param quantumMs - Window size in ms; the result is `floor(now / quantumMs) * quantumMs`.
 * @returns The current window's start instant, in epoch ms.
 */
const useNowMillis = (quantumMs: number): number => {
  const snapshot = (): number => Math.floor(Date.now() / quantumMs) * quantumMs
  return useSyncExternalStore(noopSubscribe, snapshot, snapshot)
}

/**
 * Today's **local** calendar day as `YYYY-MM-DD`, read through
 * `useSyncExternalStore` so the component's render stays pure. The day string is
 * naturally stable within a day, so the snapshot is cached for the same reason
 * {@link useNowMillis} quantizes — see its remarks. Local (not UTC) so it lines
 * up with a calendar's "today" marker.
 *
 * @returns The viewer's current local day, `YYYY-MM-DD`.
 */
const useNowDay = (): string => {
  const snapshot = (): string => {
    const now = new Date()
    return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
  }
  return useSyncExternalStore(noopSubscribe, snapshot, snapshot)
}

export { useNowDay, useNowMillis }
