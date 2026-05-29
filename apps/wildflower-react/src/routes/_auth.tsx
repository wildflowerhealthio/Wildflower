import { createFileRoute } from '@tanstack/react-router'

import { AuthorizedAppShell } from '../session/authorized-app-shell.tsx'

/**
 * Pathless `_auth` layout. Gates owner-facing routes on a live bearer
 * token via `AuthorizedAppShell`. Each slice's `_auth/` directory is
 * mounted as a child of this layout by the virtual-route config, so the
 * slice-local URLs (e.g. `/collector`) gain no extra path segment.
 */
export const Route = createFileRoute('/_auth')({ component: AuthorizedAppShell })
