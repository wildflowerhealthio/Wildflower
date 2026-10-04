import { useRouteContext } from '@tanstack/react-router'

import type { RouterContext, RunAuthed } from '../router-context.ts'

/**
 * Read the authed runner from router context, for the `queryFn`s in each
 * resource module.
 *
 * Annotated `select` so the result stays typed when the slice's router
 * isn't registered (standalone build) — without a registered Router,
 * `useRouteContext()` widens to `any`; the explicit `(context: RouterContext)`
 * annotation re-narrows it with no cast.
 */
const useRunAuthed = (): RunAuthed =>
  useRouteContext({ from: '__root__', select: (context: RouterContext) => context.runAuthed })

export { useRunAuthed }
