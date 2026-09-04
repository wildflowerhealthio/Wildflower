/**
 * Whether the viewer has asked the OS for reduced motion.
 *
 * Returns `false` in non-browser environments (no `window`) and in
 * browser-like environments that lack `matchMedia` (e.g. jsdom), so callers
 * can gate a decorative animation behind a single truthy check.
 */
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

export { prefersReducedMotion }
