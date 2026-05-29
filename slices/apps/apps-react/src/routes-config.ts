import { physical, rootRoute } from '@tanstack/virtual-file-routes'

/**
 * Three subtree mounts at the slice root. Each subdirectory's contents
 * land at the URL prefix the app expects when the macro composes them.
 * Subdirectories may be empty when the slice doesn't contribute to that
 * bucket — apps only has `_auth` routes today.
 */
export default rootRoute('slice-root.tsx', [
  physical('/', 'routes/_open'),
  physical('/', 'routes/_auth'),
  physical('/settings', 'routes/_settings'),
])
