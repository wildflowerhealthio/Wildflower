import { createFileRoute } from '@tanstack/react-router'
import { BaseLayout } from '@wildflowerhealthio/servers-react'

/**
 * Pathless layout for the base's screens, `servers-react`'s
 * `routes/_servers/`, mounted beneath it in `routes.config.ts`: the page
 * shell.
 */
export const Route = createFileRoute('/_servers')({ component: BaseLayout })
