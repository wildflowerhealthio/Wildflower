import { createFileRoute, Outlet } from '@tanstack/react-router'

/**
 * Pathless `_open` layout — a passthrough that mounts public,
 * unauthenticated slice routes (e.g. the RFC 8628 device-entry and
 * OAuth-polling screens). It contributes the `/_open` id prefix (so the
 * id matches what each slice's own `_open/` directory generates) but no
 * URL segment and no auth gate; the provider stack from `RootShell`
 * higher up is all these routes need.
 */
export const Route = createFileRoute('/_open')({ component: Outlet })
