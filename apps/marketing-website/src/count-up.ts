/*
 * Stats count-up — TypeScript port of the design handoff's reference
 * implementation (`.local-notes/design_handoff_wildflower_home/count-up.js`).
 *
 * Behavior contract (see the handoff README, "Interactions & Behavior"):
 *  - targets are read from the rendered DOM, so editing a number or adding a
 *    row needs no JS change; "10+" animates to 10 and keeps the "+" suffix
 *  - 900ms per number, 90ms stagger per row, easeOutCubic, one rAF loop
 *  - number-cell widths are pinned before digits change so the max-content
 *    grid column can't jitter
 *  - runs once per element (`data-counted` guard, which also absorbs React
 *    StrictMode's double-invoked effects)
 *  - skipped entirely under `prefers-reduced-motion: reduce`
 */

type CountUpOptions = {
  readonly duration?: number
  readonly stagger?: number
  readonly once?: boolean
  /** Frame scheduler, injectable for tests. Defaults to `requestAnimationFrame`. */
  readonly schedule?: (callback: (now: number) => void) => void
  /** Clock for the animation start time, injectable for tests. */
  readonly now?: () => number
}

type CountItem = {
  readonly node: Text
  readonly target: number
  readonly suffix: string
}

const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3

/**
 * Animates each number cell of the stats grid from 0 to the value already
 * rendered in the DOM.
 *
 * @param host - The stats grid container, a two-column grid whose children
 *   alternate number cell, label cell, number cell, label cell, …
 * @param options - Timing overrides and injectable scheduler/clock for tests.
 */
function countUpStats(host: HTMLElement, options: CountUpOptions = {}): void {
  const {
    duration = 900,
    stagger = 90,
    once = true,
    schedule = (callback) => requestAnimationFrame(callback),
    now = () => performance.now(),
  } = options

  if (once && host.dataset['counted'] === '1') return
  // `matchMedia` is absent in some non-browser environments (e.g. jsdom).
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
  if (once) host.dataset['counted'] = '1'

  // Even-indexed children are the number cells.
  const cells = Array.from(host.children).filter((_, index) => index % 2 === 0)

  const items = cells.flatMap((cell): CountItem[] => {
    if (!(cell instanceof HTMLElement)) return []
    const node = cell.firstChild
    if (!(node instanceof Text)) return []
    const raw = node.nodeValue ?? ''
    const target = Number.parseInt(raw, 10)
    if (!Number.isFinite(target)) return []
    // Pin the cell's width before digits change.
    cell.style.minWidth = `${cell.offsetWidth}px`
    return [{ node, target, suffix: raw.replaceAll(/[\d\s]/g, '') }]
  })

  if (items.length === 0) return

  for (const item of items) {
    item.node.nodeValue = `0${item.suffix}`
  }

  const start = now()

  const tick = (frameNow: number): void => {
    let running = false
    items.forEach((item, index) => {
      const t = Math.min(1, Math.max(0, (frameNow - start - index * stagger) / duration))
      const next = `${Math.round(easeOutCubic(t) * item.target)}${item.suffix}`
      if (item.node.nodeValue !== next) item.node.nodeValue = next
      if (t < 1) running = true
    })
    if (running) schedule(tick)
  }

  schedule(tick)
}

export { countUpStats }
export type { CountUpOptions }
