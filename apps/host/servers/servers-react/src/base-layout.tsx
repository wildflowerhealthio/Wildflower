import { Outlet } from '@tanstack/react-router'
import { pageLayoutStyles } from '@wildflowerhealthio/react-tundraish'
import type { JSX, ReactNode } from 'react'

/**
 * The base's page shell, around `children`, or around the matched child
 * route when it has none: the `/servers` route's component, and the shell
 * `/settings` renders its page in.
 */
function BaseLayout({ children }: { readonly children?: ReactNode }): JSX.Element {
  return <div className={pageLayoutStyles['page']}>{children ?? <Outlet />}</div>
}

export { BaseLayout }
