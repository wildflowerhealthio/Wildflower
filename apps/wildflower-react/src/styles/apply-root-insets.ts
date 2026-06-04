import type { SafeAreaInsets } from 'navigation-react'

/**
 * Pad the page's `#root` element by the host's safe-area insets so the
 * SPA's top-level chrome clears the notch / status bar / rounded corners.
 *
 * The padding sits *inside* `#root`'s border box (`#root` is
 * `box-sizing: border-box` in `global.css`), so the inset strip shows the
 * page background (`body`'s `--color-neutral-9`) and the content area
 * shrinks rather than overflowing the viewport. `bottom` is always `0`
 * here — the host forces it so the native tab bar below the WebView isn't
 * doubled up — but it's applied verbatim so the contract stays honest.
 *
 * No-op when `#root` is absent (e.g. before mount); the next
 * `SafeAreaInsetsChanged` re-applies once it exists.
 */
const applyRootInsets = ({ top, bottom, left, right }: SafeAreaInsets): void => {
  const root = document.getElementById('root')
  if (root === null) return
  root.style.padding = `${top}px ${right}px ${bottom}px ${left}px`
}

export { applyRootInsets }
